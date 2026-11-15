This experimental release puts your mailbox next to your threads: connect an
iCloud, Gmail or other IMAP account, read, search, sort and move mail with a
click or a key, write and send mail, translate a message, and let an agent
propose mail you confirm.

## What you get

- A **Mail** page with an unread badge, folders with unread counts,
  conversations, search and a reading pane with sanitized HTML. Every folder
  syncs on the BB server every 5 minutes, last 30 days (both settings).
  Gmail labels are folders; Important and Starred are skipped.
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Read state and flags sync both ways. Select conversations to mark, flag,
  archive, delete or **Move to…** at once.
- **Details** shows headers and MIME structure. Downloads use a one-time
  60-second link; nothing is kept.
- Gmail-style hotkeys; `?` lists them.
- **Translate** (`t`) streams a plain-text translation through the
  provider and model you pick in Makosh AI. Only the subject and text are
  sent, never attachments; kept locally until **Clear translations**.
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
- SMTP uses the app password; iCloud and Gmail are filled in for you.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`, which also gates the CLI in agent threads. Mentions and Hand
to agent work without it. No tool marks, moves or downloads mail.

`mail_propose`, off until you turn on `agentPropose`, lets an agent propose
a message, reply or forward. It never sends: a card in its thread shows
every address (new, agent-added and outside ones flagged, Bcc always
shown), the text, its links and attachments. **Send** queues exactly that
with the 10 s Undo, **Open in Mail** makes it your draft, **Cancel** drops it.

Neither setting is a barrier against an agent with shell access to the BB
server machine: it can reach the plugin's internal calls, sending, answering
a card and translating included. Each send still shows its Undo toast on an
open Mail page and sits in the Outbox; cards and sends are capped.

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
- The page bundle is about 640 KB, mostly the editor.

## Not yet

Creating or renaming folders, Gmail API or OAuth, signatures.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
