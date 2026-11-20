This experimental release puts your mailbox next to your threads: read,
sort, snooze and send iCloud, Gmail or IMAP mail, use AI on your click, and
hand mail to BB projects, threads and Taskboard.

## What you get

- A **Mail** page with sanitized HTML. Every folder syncs on the BB server
  every 5 minutes, last 30 days; the Inbox within seconds (IDLE).
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Mark, flag, archive, delete or **Move to…** a selection; **Undo** (`z`);
  filters; Inbox tabs; Gmail and Apple keys (`?`).
- Remote images stay hidden until you allow them; trackers never load.
- Warnings for a failed sender check, a foreign Reply-To or a lookalike
  domain; links lose tracking and open after a check; no read receipts.
- **Hand to agent** and `@` mentions share a message you pick.

## Search, folders and files

- Operators (`from:`, `has:attachment`, `-in:`), saved
  searches, **Search on the server** and **Load 30 more days**, read-only.
- Create, rename, delete folders; drag onto them; Gmail labels with Undo.
- A viewer for images, text and PDF; **Files**; opt-in search inside
  attachments, yours only.
- Hidden quotes, plain text, dark mail, sender card, related mail, print.

## Inbox tools

Toasts for new mail from people you write to. **Unsubscribe** asks first.
**Snooze** (`b`) and **Block** rules move mail later on their own.

## AI on your click

**Translate**, **Summarize**, **Ask**, **Find tasks**, **categories**,
**Today**, **reply reminders**, **Improve**, **Write with AI**. Off by
default: reply drafts and AI labels for new mail. Nothing is sent
without you. Makosh AI gets subjects, names, dates, unquoted bodies;
never addresses or files.

## BB integration

- **New thread…** shows the exact prompt and permission mode first;
  **Make a task…** on Taskboard or in Mail.
- **Save to project…** writes attachments into a project, never
  overwriting without asking; **Attach from BB** picks files.
- **Email the result** drafts a thread's answer.
- **Dev** groups GitHub, CI and monitoring mail; code and diffs use BB's
  highlighter.
- Patches go to an agent in a worktree; alerts open one incident thread.
- **Mail rules** (off) prepare threads, or start capped ones in a
  worktree.

## Your secrets and agents

Codes, passwords, tokens and card numbers become `[hidden …]` before any
agent, model or BB thread sees them (a heuristic); encrypted mail never
does. **AI access** limits agents and AI to chosen accounts and folders.
**Agent activity** logs every hand-off, ids only. Outside
assistants read the same over local MCP (off by default).

## Writing and sending

**Compose**, **Reply**, **Forward** with rich text, files up to 25 MB,
signatures, templates, autocorrect. **Send** waits 10 seconds with **Undo**,
then goes out over SMTP (TLS).

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`. `mail_propose` (off) proposes mail on a card; only **Send**
sends it. `mail_triage` (off) proposes inbox actions you tick.

An agent with a shell can still call the page's methods. Other plugins
get nothing without your grant in **Plugin access**.

## What it changes on the server

Read state, flags and moves on your click or key, and by your snoozes and
block rules. Delete moves to Trash. Drafts and sent copies are appended.
Folders and Gmail labels on your click; nothing is expunged. Server search
sends your words only to your mail server. The only web request is a
one-click unsubscribe you confirmed.

## What it costs

- An app password per account, or Google sign-in for Gmail.
- Mail and encrypted credentials stay on the BB server.
- Allowing images or unsubscribing tells senders you read the mail.
- The page bundle is about 2.7 MB, mostly pdf.js and the editor.

## Not yet

Gmail API or OAuth, semantic search.

## Source

Requires BB 0.49 or later. MIT, https://github.com/Mesteriis/bb-makosh-mail,
with parts ported from Velo (Apache-2.0).
