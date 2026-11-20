# Makosh Mail: Smart Send and sender insights — design

Date: 2026-11-20. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"). The decisions below are the builder's and
are listed in the final report. Sixth of nine projects that bring
Superhuman Mail's features to Makosh Mail.

## Intent

Superhuman suggests the time a message is most likely to be read and
tells the owner who they are writing to. It does that with read statuses
and outside profile data. Makosh Mail does the same from the mail already
stored on this computer: no outside service, no model.

## Goals

- **Smart send.** Send later offers one more time: when the recipient
  usually writes. From the first To recipient's own messages of the last
  180 days (at least 5): the busiest hour of the day in the owner's local
  time, on the days of the week they write; the next such hour at least
  an hour from now. The row says why: "Ann usually writes around 09:00".
  Without enough mail the row is not shown.
- **Sender insights** in the sender card:
  - how fast they answer the owner, and the owner them (the median, from
    messages that answer one another by In-Reply-To);
  - when they usually write (the busiest three-hour span and the days);
  - who they write with most (up to three other people in their
    conversations with the owner).

## Non-goals

- Profile data from the web (photo, job title, social networks): needs an
  outside service.
- The recipient's time zone: stored dates are in UTC, the sender's offset
  is not kept; the hour they write in the owner's time is what matters for
  a send time anyway.
- A model: everything is counted.

## Anti-goals

- Anything about a correspondent leaving the computer.
- A confident line from thin data: under 5 messages, or under 3 answered
  pairs for a median, nothing is said.
- A suggested time in the past or closer than an hour.

## Rules (pure, `src/core/sender-rhythm.ts`)

Input: dated messages between the owner and one address: incoming (date,
Message-ID, In-Reply-To, other To/Cc addresses) and outgoing (date,
Message-ID, In-Reply-To), newest 500 of each within 180 days.

- Hours and weekdays are read in the owner's local time (the server's).
- The usual hour: the hour with the most incoming messages; ties go to
  the earlier hour. The usual span: the three consecutive hours holding
  the most. The usual days: weekdays (Mon–Fri) when at least 80 % of the
  messages fall on them, else every day.
- The smart time: the next occurrence of the usual hour, on a usual day,
  at least 60 minutes from now.
- Their reply time: for each incoming message whose In-Reply-To is the
  Message-ID of an outgoing one, the minutes between them; the median over
  at least 3. The owner's reply time the same way round. Pairs more than
  14 days apart are left out.
- Most with: the other addresses in To/Cc of incoming messages, the
  owner's own left out, by count, at most 3, at least 2 messages each.

## Methods and page

- `sender_card` gains `insights` (null when there is too little mail):
  `theirReplyMinutes`, `ownReplyMinutes`, `usualFrom`, `usualTo`,
  `weekdaysOnly`, `mostWith`.
- New owner-only method `smart_send_time({ draftId })` →
  `{ at, hour, name } | null` for the draft's first To recipient.
- The composer's Send later menu asks it when it opens and shows the row
  first; the sender card shows an "Insights" block.

## Testing

The rules by example with fixed dates (expected literals, time zone fixed
in the test); both stores give the same exchange rows; the server method;
the menu row and the card block with fake ports; another plugin refused.
