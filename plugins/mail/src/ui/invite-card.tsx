// A calendar invitation in a message (slice 3l): what, when, where and who,
// read from the message's calendar part when the message opens. Accept,
// Maybe and Decline send the owner's answer to the organizer through the
// Outbox, with its Undo; nothing is answered without that click. Everything
// from the invitation is rendered as text.
import { useEffect, useRef, useState } from "react";
import type { InviteAnswer, InviteMoment, InviteStatus, InviteView } from "../core/calendar-invite.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { dateLocale, msg, tx } from "./i18n/index.ts";

export interface InvitePorts {
  view: (messageId: string) => Promise<{ invite: InviteView | null; answerable: boolean }>;
  /** Queues the answer; the page shows the Undo toast. */
  reply: (messageId: string, answer: InviteAnswer) => Promise<void>;
}

const KIND: Record<InviteView["method"], string> = {
  request: msg("Invitation"),
  cancel: msg("Cancelled event"),
  reply: msg("Answer to an invitation"),
  publish: msg("Event"),
  other: msg("Event"),
};

const STATUS: Record<InviteStatus, string> = {
  accepted: msg("accepted"),
  tentative: msg("maybe"),
  declined: msg("declined"),
  needs_action: msg("no answer yet"),
  delegated: msg("delegated"),
  unknown: msg("no answer yet"),
};

const ANSWERS: { answer: InviteAnswer; label: string; done: string }[] = [
  { answer: "accepted", label: msg("Accept"), done: msg("Your answer is on its way: accepted.") },
  { answer: "tentative", label: msg("Maybe"), done: msg("Your answer is on its way: maybe.") },
  { answer: "declined", label: msg("Decline"), done: msg("Your answer is on its way: declined.") },
];

/** The local Date of a wall time ("2026-11-20T09:00" or "2026-11-20"), or null. */
function wallDate(wall: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(wall);
  if (match === null) return null;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i] ?? "0")) as [number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi);
}

const dayText = (date: Date) =>
  date.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "long", year: "numeric" });
const timeText = (date: Date) => date.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * When the event is, in the owner's own time when the invitation's zone is
 * known; otherwise the time as written with the zone's name beside it.
 */
export function inviteWhenText(start: InviteMoment | null, end: InviteMoment | null): string {
  if (start === null) return tx("The time is not given");
  if (start.allDay) {
    const first = wallDate(start.wall);
    if (first === null) return tx("The time is not given");
    // A whole-day end is the day after the last one.
    const after = end !== null && end.allDay ? wallDate(end.wall) : null;
    const last = after === null ? null : new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1);
    return last !== null && last.getTime() > first.getTime()
      ? `${dayText(first)} \u2013 ${dayText(last)}`
      : tx("{day}, all day", { day: dayText(first) });
  }
  const local = start.utc !== null;
  const from = local ? new Date(start.utc!) : wallDate(start.wall);
  if (from === null || Number.isNaN(from.getTime())) return tx("The time is not given");
  const to = end === null || end.allDay ? null : local ? (end.utc === null ? null : new Date(end.utc)) : wallDate(end.wall);
  const range =
    to === null || Number.isNaN(to.getTime())
      ? `${dayText(from)}, ${timeText(from)}`
      : sameDay(from, to)
        ? `${dayText(from)}, ${timeText(from)} \u2013 ${timeText(to)}`
        : `${dayText(from)}, ${timeText(from)} \u2013 ${dayText(to)}, ${timeText(to)}`;
  if (local) return range;
  return start.zone === null ? tx("{when} (time zone not given)", { when: range }) : `${range} (${start.zone})`;
}

function person(entry: { name: string | null; address: string }): string {
  return entry.name === null ? entry.address : `${entry.name} <${entry.address}>`;
}

const SHOWN_ATTENDEES = 5;

export function InviteCard({ messageId, ports }: { messageId: string; ports: InvitePorts }) {
  const [loaded, setLoaded] = useState<{ invite: InviteView | null; answerable: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = useRef(messageId);
  current.current = messageId;

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(false);
    setEveryone(false);
    setBusy(false);
    setDone(null);
    setProblem(null);
    ports.view(messageId).then(
      (result) => {
        if (live) setLoaded(result);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
    // The ports are stable for the page; a new message or Retry reads again.
  }, [messageId, attempt]);

  if (failed) {
    return (
      <section aria-label={tx("Calendar invitation")} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-muted-foreground">
        <Icon name="Calendar" fallback="Info" className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{tx("The invitation could not be read from the server.")}</span>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setAttempt((n) => n + 1)}>
          {tx("Retry")}
        </Button>
      </section>
    );
  }
  if (loaded === null) {
    return (
      <p role="status" className="rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-muted-foreground">
        {tx("Reading the invitation\u2026")}
      </p>
    );
  }
  const invite = loaded.invite;
  if (invite === null) return null;

  const answer = async (choice: (typeof ANSWERS)[number]) => {
    setBusy(true);
    setProblem(null);
    try {
      await ports.reply(messageId, choice.answer);
      if (current.current === messageId) setDone(tx(choice.done));
    } catch (error) {
      if (current.current === messageId) {
        setProblem(tx(error instanceof Error && error.message !== "" ? error.message : "The request failed; try again"));
      }
    } finally {
      if (current.current === messageId) setBusy(false);
    }
  };

  const shown = everyone ? invite.attendees : invite.attendees.slice(0, SHOWN_ATTENDEES);
  const hidden = invite.attendeesTotal - shown.length;
  const answered = invite.method === "reply" ? (invite.attendees[0] ?? null) : null;
  return (
    <section aria-label={tx("Calendar invitation")} className="flex flex-col gap-1.5 rounded-md border border-border bg-muted px-3 py-2 text-sm">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon name="Calendar" fallback="Info" className="size-3.5" aria-hidden />
        {tx(KIND[invite.cancelled ? "cancel" : invite.method])}
      </p>
      <p className={invite.cancelled ? "font-medium text-foreground line-through" : "font-medium text-foreground"}>
        {invite.summary === "" ? tx("(no title)") : invite.summary}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-foreground">
        <dt className="text-muted-foreground">{tx("When")}</dt>
        <dd>
          {inviteWhenText(invite.start, invite.end)}
          {invite.recurring ? <span className="text-muted-foreground"> {tx("Repeats; this is the first time.")}</span> : null}
        </dd>
        {invite.location !== null ? (
          <>
            <dt className="text-muted-foreground">{tx("Where|place")}</dt>
            <dd className="break-words">{invite.location}</dd>
          </>
        ) : null}
        {invite.organizer !== null ? (
          <>
            <dt className="text-muted-foreground">{tx("Organizer")}</dt>
            <dd className="break-words">{person(invite.organizer)}</dd>
          </>
        ) : null}
        {answered !== null ? (
          <>
            <dt className="text-muted-foreground">{tx("Answer")}</dt>
            <dd className="break-words">
              {person(answered)}: {tx(STATUS[answered.status])}
            </dd>
          </>
        ) : invite.attendees.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{tx("Invited")}</dt>
            <dd>
              <ul aria-label={tx("Invited")} className="flex flex-col">
                {shown.map((attendee) => (
                  <li key={attendee.address} className="break-words">
                    {person(attendee)}
                    <span className="text-muted-foreground">
                      {" \u00b7 "}
                      {tx(STATUS[attendee.status])}
                      {attendee.optional ? `, ${tx("optional")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {hidden > 0 ? (
                everyone ? (
                  <span className="text-muted-foreground">{tx("and {count} more", { count: hidden })}</span>
                ) : (
                  <button
                    type="button"
                    className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setEveryone(true)}
                  >
                    {tx("and {count} more", { count: hidden })}
                  </button>
                )
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {invite.description !== null ? (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{invite.description}</p>
      ) : null}
      {invite.self !== null && invite.self.status !== "needs_action" && invite.self.status !== "unknown" && invite.method === "request" ? (
        <p className="text-xs text-muted-foreground">
          {tx("The invitation lists you as: {status}.", { status: tx(STATUS[invite.self.status]) })}
        </p>
      ) : null}
      {loaded.answerable ? (
        done !== null ? (
          <p role="status" className="text-xs text-muted-foreground">
            {done}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {ANSWERS.map((choice) => (
              <Button key={choice.answer} variant="outline" size="sm" className="h-7 px-2" disabled={busy} onClick={() => void answer(choice)}>
                {tx(choice.label)}
              </Button>
            ))}
            <span className="text-xs text-muted-foreground">{tx("Your answer goes to the organizer by email.")}</span>
          </div>
        )
      ) : null}
      {problem !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
