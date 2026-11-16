This experimental release puts your mailbox next to your threads: read,
sort, snooze and send iCloud, Gmail or IMAP mail, use AI on your click, and
let an agent propose mail and inbox actions you confirm.

## What you get

- A **Mail** page: unread badge, folders, conversations, search, sanitized
  HTML. Every folder syncs on the BB server every 5 minutes, last 30 days;
  the Inbox also within seconds (IMAP IDLE).
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Mark, flag, archive, delete or **Move to…** a selection; **Undo** or `z`;
  filters; hotkeys (`?`).
- Remote images stay hidden until you allow them; downloads use a one-time
  60-second link.
- **Hand to agent** and an `@` mention give an agent a message you picked.

## Inbox tools

- Toasts for new mail from people you write to (sender only). Quiet hours.
- **Unsubscribe** asks first; one click only on Gmail with DKIM vouching.
- **Snooze** (`b`) into a "Snoozed" folder created on your confirmation.
- **Block** an address or domain: rules move new Inbox mail to Spam.

## AI on your click

Through Makosh AI only, on your click only: **Translate**, **Summarize** with
cited messages, **Ask** your mail, **Find tasks** for a local Tasks list,
local **categories**, a **Today** view, **reply reminders** and **Improve**
for your draft behind a diff you apply. Answers are plain text; nothing a
model says acts without your click.

What goes to the provider: subjects, sender names, dates and bodies without
quotes of the mail involved; your question; your own draft text. Never
recipients' addresses, attachments, images or HTML.

## Your secrets and agents

Codes, passwords, tokens and card numbers become `[hidden …]` before any
agent or model sees them. It is a heuristic: unusual formats can pass.
**AI access** limits agents and AI to chosen accounts and folders (Spam and
Trash never) and excludes senders. **Agent activity** logs every agent and AI
call locally, ids and counts only.

## Writing and sending

- **Compose**, **Reply**, **Reply all**, **Forward**: rich text,
  attachments up to 25 MB, signatures, templates, advisory checks.
- **Send** waits 10 seconds with **Undo**, then goes out over SMTP with TLS.
  The **Outbox** shows every send not done.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`. `mail_propose` (`agentPropose`, off) proposes mail on a card;
only **Send** sends it. `mail_inbox` and `mail_triage` (`agentTriage`, off)
propose inbox actions; only the ones you tick run.

None of this stops an agent with shell access to the BB server: it can call
the page's own methods (`ai_start`, `message_body`, `thread_get`, `search`,
`unsubscribe_run` among them). Sends still show Undo.

## What it changes on the server

Read state, flags and moves on your click or key, and by your snoozes and
block rules. Snooze creates one folder per account when you confirm. Delete
moves to Trash. Drafts and sent copies are appended; only its own superseded
drafts are expunged. Categories, tasks and reminders stay local: nothing new
is written in this release. The only web request is a one-click unsubscribe
you confirmed.

## What it costs

- An app password per account; Gmail needs 2-step verification.
- Mail and encrypted credentials stay on the BB server.
- One more IMAP connection per account while BB runs.
- Allowing images or unsubscribing tells senders you read the mail.
- The page bundle is about 770 KB, mostly the editor.

## Not yet

Renaming folders, Gmail API or OAuth.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
