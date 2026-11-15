This experimental release puts your mailbox next to your threads: connect an
iCloud, Gmail or other IMAP account, read, search, sort and move mail with a
click or a key, write and send mail, and give one message to an agent.

## What you get

- A **Mail** page with an unread badge, folders with unread counts,
  conversations, search and a reading pane with sanitized HTML. Every folder
  syncs on the BB server every 5 minutes, last 30 days (both settings).
  Gmail labels are folders; Important and Starred are skipped.
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Read state and flags sync both ways. Select conversations to mark, flag,
  archive, delete or **Move to…** at once.
- **Details** shows headers and MIME structure. .eml and attachment
  downloads use a one-time 60-second link; nothing is kept.
- Gmail-style hotkeys; `?` lists them.
- Remote images stay hidden until **Show images** or **Always show from**.
- **Hand to agent** and an `@` mention under **Mail** give an agent a
  message you picked.
- While the Mail page is open, BB's sidebar shows your accounts and folders
  instead of chats.

## Writing and sending

- **Compose**, **Reply**, **Reply all** and **Forward** (`c`, `r`, `a`,
  `f`): address chips, rich text, attachments up to 25 MB.
- Drafts save locally within seconds. On servers with UIDPLUS a copy goes
  to Drafts so other clients see it; without it drafts stay local.
- **Send** waits 10 seconds with **Undo**, then goes out over SMTP with TLS.
  The Sent copy keeps Bcc; Gmail's own Sent copy does not show it.
- The **Outbox** at the top of Sent shows every send not done: Undo while
  queued, Send now or Edit if held after a restart, Retry, Edit or Discard
  after a failure, Send again or Discard if it may have been sent. Nothing
  resends on its own.
- SMTP uses the app password: iCloud `smtp.mail.me.com` 587 STARTTLS,
  Gmail `smtp.gmail.com` 465 TLS, filled in for you; other servers ask.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`, which also gates the CLI's `accounts`, `search` and `read` in
agent threads. Mentions and Hand to agent work without it. No tool, command
or mention marks, moves, downloads, drafts or sends mail. Drafts synced from
the server, yours included, are visible to `mail_search`.

`agentTools` is not a barrier against an agent with shell access to the
machine running the BB server: it can reach the plugin's internal calls,
sending included. Every send still shows its Undo toast on an open Mail
page, sits in the Outbox, and each account sends at most 10 a minute.

Text handed to an agent is sent to that agent's model provider.

## What it changes on the server

Read state, flags and moves happen only on your click or key. Delete moves
to Trash; moves need `MOVE` or `UIDPLUS`. Details and downloads never mark
mail read. It appends your drafts to Drafts and sent copies to Sent (Gmail
keeps its own). It expunges only its own superseded drafts, by UID, on
servers with UIDPLUS; nothing else is permanently deleted.

## What it costs

- An app password per account; Gmail needs 2-step verification for one.
- Mail and credentials stay on the BB server machine; passwords are
  encrypted.
- Allowing a sender's images tells their servers you opened the mail.
- The page bundle is about 600 KB, mostly the editor.

## Not yet

Creating or renaming folders, Gmail API or OAuth, signatures, and agents
that draft or send.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
