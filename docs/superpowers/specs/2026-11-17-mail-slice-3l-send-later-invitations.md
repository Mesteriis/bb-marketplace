# Mail slice 3l: Send later, important senders, calendar invitations

Three backlog items that need nothing from the owner but a decision already
given ("делаем, сам делай"): 52 scheduled send, 71 important senders next to
the quiet hours of slice 3e, 70 calendar invitations.

## Decisions

- **Send later.** A scheduled send is an ordinary `queued` outbox row with
  `scheduled = 1` and the picked time as `send_after`; no new state. The
  MIME is built when the owner schedules, with the picked time as its Date,
  so the row offers Edit only: sending it early as built would put a future
  Date on the message. The time is one minute to 365 days ahead, checked by
  the page and again by the server. Only the owner's composer can ask; an
  agent send is refused.
- **After a restart.** An ordinary overdue row is held, as before. A
  scheduled row less than 24 hours late stays queued and goes out; later
  than that it is held, and Send now gives it the usual Undo window and
  clears the mark.
- **Important senders.** Addresses and domains (a domain covers its
  subdomains), at most 200, in the `importantSenders` setting. They pass
  the "someone you wrote to" and mailing-list checks and quiet hours; own
  and blocked addresses still never notify. `notifyImportantOnly` limits
  toasts to them. Quiet hours with nobody named silence everything.
- **Invitations.** The calendar part is read from the server on each open
  (`invite_view`) and nothing is stored. Only the first event is read; a
  series shows its master event. Times resolve through the runtime's zone
  data for IANA names, then through the file's own VTIMEZONE (Outlook's
  zone names); otherwise the time is shown as written with the zone name.
- **Answering.** `invite_reply` builds an iTIP REPLY (RFC 5546: UID,
  SEQUENCE, DTSTAMP, ORGANIZER, the one ATTENDEE, SUMMARY; no DTSTART, so
  no zone definition is needed) and queues it as a hidden purpose draft
  (`invite_reply`), like the unsubscribe email, so it keeps the Outbox Undo.
  Answerable: METHOD REQUEST, not cancelled, a UID, an organizer, one of
  the account's sending addresses among the attendees, and a folder that is
  not Spam or Trash. Both methods refuse plugin callers; agents get no tool.

## What was built

- `src/core/send-later.ts`, `src/ui/send-later-menu.tsx`; `queueSend` takes
  `sendAt`; `compose_send` gains `sendAt`; `OutboxRow.scheduled`.
- Store: migration element 16 (`outbox.scheduled`), pinned as
  `MIGRATIONS.slice(0, 17)`. `outboxById` is prepared on first use, because
  it names a column a database still being migrated does not have.
- `src/core/notify.ts`: `parseImportantSenders`, `isImportantSender`; two
  settings in `server.ts`.
- `src/core/calendar-invite.ts` (`parseInvite`, `buildInviteReply`,
  `isCalendarPart`), `src/adapters/bb/invite.ts`, `src/ui/invite-card.tsx`;
  `planInviteReply` in `compose.ts`; `OutgoingMessage.calendar`, sent by the
  MIME builder as nodemailer's `icalEvent`.
- Contract: 166 methods; `SLICE_3L_METHODS` = `invite_view`, `invite_reply`.
- Russian texts for all of it.

## Not done

- Mail keeps no calendar and does not remember the owner's answer.
- A changed occurrence of a series, several events in one file and
  counter-proposals are not shown separately.
- A calendar part in a charset other than UTF-8 may show wrong letters.
- No settings page of Mail's own for important senders: they are edited in
  BB's plugin settings as text.
- Not tried on real mail: an invitation from Google Calendar and one from
  Outlook, and whether their servers take the answer. No second review
  pass and no rendered preview.
