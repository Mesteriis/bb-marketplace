This experimental release puts your mailbox next to your threads: read,
sort, snooze and send iCloud, Gmail or IMAP mail, translate it, and let an
agent propose mail and inbox actions you confirm.

## What you get

- A **Mail** page: unread badge, folders, conversations, search, sanitized
  HTML. Every folder syncs on the BB server every 5 minutes, last 30 days;
  the Inbox also within seconds (IMAP IDLE).
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash.
- Mark, flag, archive, delete or **Move to…** a selection; **Undo** or `z`.
  **Unread**, **Flagged** and **Attachments** filters; hotkeys (`?`).
- **Translate** (`t`) through Makosh AI: only the subject and text are sent.
- **Details** shows headers; downloads use a one-time 60-second link.
- Remote images stay hidden until you allow them.
- **Hand to agent** and an `@` mention give an agent a message you picked.

## Inbox tools

- Toasts for new mail from people you write to: sender only, never the
  subject; quiet hours on the BB server's clock. In-app, not system
  notifications.
- **Unsubscribe** confirms your address is read, so it asks first. One click
  only on Gmail with the provider's DKIM vouching, else an email with Undo.
- **Snooze** (`b`) creates a "Snoozed" folder on your confirmation; mail
  comes back only while BB runs.
- **Block** an address or domain: rules move new Inbox mail to Spam.

## Writing and sending

- **Compose**, **Reply**, **Reply all**, **Forward**: rich text,
  attachments up to 25 MB.
- Sending addresses with signatures; templates; advisory checks before
  sending. The plugin cannot verify an alias.
- **Send** waits 10 seconds with **Undo**, then goes out over SMTP with TLS.
  The **Outbox** shows every send not done; nothing resends on its own.

## Agent access

`mail_search`, `mail_read` and the `mail` skill are off until you turn on
`agentTools`. No tool marks, moves or downloads mail.

`mail_propose` (`agentPropose`, off) proposes a message, reply or forward on
a card showing every address, the text and attachments. **Send** queues
exactly that with Undo; nothing is sent otherwise.

`mail_inbox` and `mail_triage` (`agentTriage`, off) propose up to 50
archive, mark read, snooze, Spam, unsubscribe or reply items on a card; only
the ones you tick run, undoable from the thread.

None of these stops an agent with shell access to the BB server machine: it
can reach the plugin's internal calls (`unsubscribe_run`, `block_add`,
`snooze_folder_create` included) and answer a card. Sends still show Undo
and sit in the Outbox.

Text handed to an agent goes to that agent's model provider.

## What it changes on the server

Read state, flags and moves change on your click or key, and by the snoozes
and block rules you set. Snooze creates one folder per account when you
confirm it. Delete moves to Trash. It appends drafts and sent copies and
expunges only its own superseded drafts, by UID; nothing else is
permanently deleted. Undo of a Gmail archive uses UID COPY. The only web
request is a one-click unsubscribe you confirmed: https, public addresses,
no cookies, no redirects.

## What it costs

- An app password per account; Gmail needs 2-step verification.
- Mail and encrypted credentials stay on the BB server.
- One more IMAP connection per account while BB runs.
- Allowing images or unsubscribing tells senders you read the mail.
- The page bundle is about 710 KB, mostly the editor.
- Pre-send checks and block rules keep local lists (addresses you sent to,
  blocked senders) until removed.

## Not yet

Renaming folders, Gmail API or OAuth.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
