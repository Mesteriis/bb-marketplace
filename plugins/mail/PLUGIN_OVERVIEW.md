This experimental release puts your mailbox next to your threads: read,
sort, snooze and send iCloud, Gmail or IMAP mail, use AI on your click, and
hand mail to BB projects, threads and Taskboard.

## What you get

- A **Mail** page with sanitized HTML. Every folder syncs on the BB server
  every 5 minutes, last 30 days; the Inbox within seconds (IDLE).
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Mark, flag, archive, delete or **Move to…** a selection; **Undo** or `z`;
  filters; hotkeys (`?`).
- Remote images stay hidden until you allow them.
- **Hand to agent** and `@` mentions share a message you pick.

## Search, folders and files

- Operators (`from:`, `has:attachment`, `newer_than:`, `-in:`), saved
  searches, **Search on the server** and **Load 30 more days**, read-only.
- Create, rename, delete folders; drag onto them; Gmail labels with Undo.
- A viewer for images, text and PDF; **Files**; opt-in search inside
  attachments, yours only.
- Hidden quotes, plain text, dark mail, sender card, related mail, print.

## Inbox tools

Toasts for new mail from people you write to. **Unsubscribe** asks first.
**Snooze** (`b`) and **Block** rules move mail later on their own.

## AI on your click

Through Makosh AI only: **Translate**, **Summarize**, **Ask** your mail,
**Find tasks**, local **categories**, **Today**, **reply reminders** and
**Improve** for your draft. Nothing a model says acts without your click.
The provider gets subjects, sender names, dates and bodies without quotes
of the mail involved; never addresses, attachments or HTML.

## BB integration

- **New thread…** from a mail shows the exact prompt and the project's
  permission mode first; **Make a task…** on Taskboard or in Mail.
- **Save to project…** writes attachments as new files in the project,
  never over a file without asking; **Attach from BB** picks files.
- **Email the result** drafts a thread's answer, unsent.
- **Dev** groups GitHub, CI and monitoring mail; links, code and diffs show
  with BB's highlighter.
- Patches go to an agent in a new worktree; alerts open one incident
  thread; conversations bind to projects.
- **Mail rules** (off) prepare threads for review, or start capped ones in
  a worktree.

## Your secrets and agents

Codes, passwords, tokens and card numbers become `[hidden …]` before any
agent, model or BB thread sees them (a heuristic). **AI access** limits
agents and AI to chosen accounts and folders and excludes senders. **Agent activity** logs every agent, AI and BB hand-off
locally, ids and counts only.

## Writing and sending

**Compose**, **Reply**, **Forward** with rich text, code blocks,
attachments up to 25 MB, signatures and templates. **Send** waits 10
seconds with **Undo**, then goes out over SMTP with TLS.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`. `mail_propose` (off) proposes mail on a card; only **Send**
sends it. `mail_triage` (off) proposes inbox actions you tick.

None of this stops an agent with shell access to the BB server: it can call
the page's own methods. Sends still show Undo.

## What it changes on the server

Read state, flags and moves on your click or key, and by your snoozes and
block rules. Delete moves to Trash. Drafts and sent copies are appended.
Folders and Gmail labels on your click; nothing is expunged. Server search
sends your words to your own mail server. The only web request is a
one-click unsubscribe you confirmed.

## What it costs

- An app password per account; Gmail needs 2-step verification.
- Mail and encrypted credentials stay on the BB server.
- Allowing images or unsubscribing tells senders you read the mail.
- The page bundle is about 2.7 MB, mostly pdf.js and the editor.

## Not yet

Gmail API or OAuth, semantic search.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
