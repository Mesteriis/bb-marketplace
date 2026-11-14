This experimental release puts your INBOX next to your threads: connect an
iCloud, Gmail or other IMAP account, read and search its mail, and give one
message to an agent when you want help with it.

## What you get

- A **Mail** page in the sidebar with an unread badge, conversation list,
  search and reading pane. HTML mail is sanitized and remote content is
  blocked.
- Each account's INBOX syncs on the BB server every 5 minutes and keeps the
  last 30 days; both are plugin settings.
- **Hand to agent** opens a new thread draft that mentions the open message,
  and an `@` mention under **Mail** adds a message's text to any prompt.

## Agent access

The tools `mail_search` and `mail_read` are off until you turn on the setting
`agentTools`, which also gates `bb makosh-mail search` and
`bb makosh-mail read` inside agent threads. Mentions and Hand to agent work
without it, because you pick the message. The CLI also has
`bb makosh-mail accounts` and `bb makosh-mail sync`.

## What it changes on the server

Opening a message on the Mail page marks it read. That is the only write:
agents, mentions and the CLI never mark mail read, and nothing sends, deletes
or moves mail.

## What it costs

- An app password per account. Gmail needs 2-step verification for one, and
  Google Workspace admins may disable app passwords.
- Mail and credentials stay on the machine that runs the BB server. Passwords
  are encrypted with a key kept in the plugin's secret settings.

## Not yet

Sending, replying, other folders, attachment download, and Gmail API or OAuth
sign-in.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
