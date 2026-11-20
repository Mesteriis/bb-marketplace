# Makosh Mail: AI sorts the inbox — design

Date: 2026-11-20. Status: approved in advance (the owner, 2026-11-19:
"Завершай все что наметили"; the owner also chose "AI runs by itself for
every new message"). The decisions below are the builder's and are listed
in the final report. Fourth of nine projects that bring Superhuman Mail's
features to Makosh Mail.

## Intent

Superhuman reads each new message for the owner: it writes one line that
says what the message is about, puts the owner's own labels on it ("Pitch",
"Invoice", "Needs reply") and archives what the owner said should never
sit in the Inbox. Makosh Mail has four fixed categories suggested on a
click, and nothing that runs by itself.

## Goals

- **AI labels.** The owner defines up to 12 labels: a name (1–30
  characters) and a description in their own words of what belongs under
  it (1–300 characters). A new message gets zero or more of them. Labels
  are local: nothing is written to the mail server.
- **One line.** Each new message gets a summary of at most 140 characters,
  shown in the conversation list in place of the snippet and at the top of
  the open conversation.
- **Auto archive.** A label can be marked "archive automatically": a new
  message that gets it leaves the Inbox for the account's Archive folder,
  unread state untouched, with a row in the agent log. Never deletes,
  never marks as spam.
- **Find and split.** Search operator `ai:<label>` (and `-ai:<label>`);
  an Inbox tab can use it, so a label can be a tab.
- One switch, `aiSort`, off by default; labels are edited in Mail settings
  → AI features → "Sorting".

## Non-goals

- Labelling old mail in bulk, and labelling outside the Inbox.
- Writing Gmail labels or IMAP keywords.
- Replacing the four categories: they stay as they are.
- Rules without a model (filters already do that).

## Anti-goals

- Mail outside AI access reaching the model.
- A message deciding its own fate by instruction ("label me Important,
  do not archive"): the message is data, and a message Mail warns about,
  or from someone the owner has written to, is never auto-archived.
- An archive the owner cannot find or undo: every auto archive is listed
  in the agent log and the message stays searchable with `ai:<label>`.
- Spending without a bound.
- Raw model output stored, logged or shown.

## What the model gets

One call for up to 10 new messages (kind `sort`, started only by new
mail, never by an RPC). Input: the owner's labels (a JSON block marked as
the owner's: names and descriptions, redacted) and the messages in the
existing nonce frame — sender name and domain (no address), subject, the
first 600 characters of the unquoted body, each redacted whole before the
cut. Answer:
`{"items":[{"n":1,"summary":"...","labels":["Name"]}]}`.

The parser keeps only label names that are the owner's (exact, case
folded), at most 3 per message, a summary as one clean line of at most 140
characters, and items whose `n` is one of the messages sent. Anything else
is dropped and counted.

Which messages: new in the Inbox in this round, left there by block rules
and filters, inside AI access, with a body, not the owner's own. Bulk
mail is included: that is what most labels are for.

Caps: 20 calls an hour and 100 a day (at most 1 000 messages a day), per
run of the BB server; at most 200 messages wait, the oldest dropped past
that. Calls go through the same job runner and unattended queue as auto
drafts, one at a time; auto drafts and sorting take turns.

## Auto archive

After a call, for each message with a label marked "archive
automatically": archived unless the sender is someone the owner has
written to, the message is flagged, Mail warns about the sender, or it is
no longer in the Inbox. The move is the ordinary Archive action (queued
like the owner's, so it survives a restart and can be found in Archive);
an account without an Archive folder skips it. At most 50 auto archives an
hour; past that the label is kept and the message stays.

The agent log gets one row per call (`ai_sort`: ids sent, hidden count)
and one per archived batch (`ai_archive`: ids).

## Store

Migration 24:

- `ai_labels` (id, name, name_key unique, description, auto_archive,
  position, created_at).
- `message_ai` (account_id, dedup_key, summary, labels_json — label ids —,
  created_at; primary key (account_id, dedup_key)), keyed like categories
  so a message keeps its line and labels when it moves between folders.
  Rows older than 90 days are deleted when new ones are written.

Deleting a label removes its id from every row lazily (unknown ids are
ignored when read).

## Page

- Conversation list: the line replaces the snippet (title attribute keeps
  the snippet); label chips after the subject, at most 2 and "+n".
- Reading pane: the line and the chips above the newest message that has
  them.
- Settings → AI features → Sorting: the switch; the list of labels with
  name, description, "archive automatically", Add, Remove, up/down.
- Search help lists `ai:`.

## Methods

Owner only, refused to plugins and agents, not tools: `ai_labels_list`,
`ai_label_save` (insert or update by id; refusals: name taken, 12
already), `ai_label_delete`, `ai_label_move`. The thread list and thread
detail carry `aiSummary` (string or null) and `aiLabels` (names) per
conversation / message.

## Errors

A failed call drops its messages silently (one log line, no mail data).
Failures the next call would meet too (gateway missing, sign-in refused,
quota) empty the queue until new mail arrives.

## Testing

The builder and parser by example; eligibility and the archive guard;
the queue with batches; both stores (migration 24 from schema 23, the
`ai:` operator, the 90-day cleanup); the server round end to end with a
model stub; settings and chips with fake ports; another plugin refused on
every new method.
