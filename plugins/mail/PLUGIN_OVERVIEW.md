This experimental release puts your mailbox next to your threads: read,
sort and send iCloud, Gmail or IMAP mail, translate it, and let an agent
propose mail you confirm.

## What you get

- A **Mail** page: unread badge, folders with unread counts,
  conversations, search, sanitized HTML. Every folder syncs on the BB
  server every 5 minutes, last 30 days. Gmail labels are folders.
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Read state and flags sync both ways. Mark, flag, archive, delete or
  **Move to…** a selection; **Undo** or `z` takes the last action back.
- **Details** shows headers; downloads use a one-time 60-second link.
- Gmail-style hotkeys (`?`).
- **Translate** (`t`) through the provider you pick in Makosh AI: only the
  subject and text are sent; kept until **Clear translations**.
- Remote images stay hidden until you allow them.
- **Hand to agent** and an `@` mention give an agent a message you picked.

## Writing and sending

- **Compose**, **Reply**, **Reply all** and **Forward** (`c`, `r`, `a`,
  `f`): address chips, rich text, attachments up to 25 MB.
- Sending addresses: the account's own and aliases you add (with
  suggestions), each with a signature. A reply starts from the address the
  mail came to. The plugin cannot verify an alias; Gmail rewrites and iCloud
  refusals are shown.
- Named templates, inserted at the cursor (Cmd/Ctrl+Alt+T).
- Before sending, advisory checks: a forgotten attachment, an empty
  subject, a recipient outside the conversation or never written to.
- Drafts save locally, and to Drafts on servers with UIDPLUS.
- **Send** waits 10 seconds with **Undo**, then goes out over SMTP with TLS.
- The **Outbox** in Sent shows every send not done with what is safe to
  do; nothing resends on its own.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`, which also gates the CLI in agent threads. Mentions and Hand
to agent work without it. No tool marks, moves or downloads mail.

`mail_propose`, off until you turn on `agentPropose`, lets an agent propose
a message, reply or forward, optionally from an alias and with a template
(`mail_templates`). It never sends: a card in its thread shows every address
(new, agent-added and outside ones flagged), the text, signature, template,
links, attachments and checks. **Send** queues exactly that with the 10 s
Undo, **Open in Mail** makes it your draft, **Cancel** drops it.
`mail_contacts` finds "accounting" in your mail headers.

Neither setting stops an agent with shell access to the BB server machine:
it can reach the plugin's internal calls, sending and answering a card
included. Each send still shows its Undo toast and sits in the Outbox.

Text handed to an agent is sent to that agent's model provider.

## What it changes on the server

Read state, flags and moves change only on your click or key. Delete moves
to Trash; moves need `MOVE` or `UIDPLUS`. Details and downloads never mark
mail read. It appends your drafts to Drafts and sent copies to Sent (Gmail
keeps its own). It expunges only its own superseded drafts, by UID, on
servers with UIDPLUS; nothing else is permanently deleted. Undo of Archive
on Gmail adds the message back to the folder it came from with UID COPY,
never into Trash or Spam (those get a move back); nothing else uses COPY.

## What it costs

- An app password per account; Gmail needs 2-step verification for one.
- Mail and credentials stay on the BB server; passwords are encrypted.
- Allowing a sender's images tells their servers you opened the mail.
- The page bundle is about 670 KB, mostly the editor.
- Pre-send checks keep a local list of addresses you sent to, Bcc
  included, until the account is removed.

## Not yet

Creating or renaming folders, Gmail API or OAuth.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
