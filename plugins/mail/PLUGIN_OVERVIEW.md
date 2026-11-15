This experimental release puts your mailbox next to your threads: connect an
iCloud, Gmail or other IMAP account, read and search every folder, sort,
flag and move mail with a click or a key, and give one message to an agent
when you want help with it.

## What you get

- A **Mail** page in the sidebar with an unread badge, a folder list with
  unread counts, conversation list, search and reading pane. HTML mail is
  sanitized.
- Every folder of each account syncs on the BB server every 5 minutes and
  syncs the last 30 days; both are plugin settings. Gmail labels appear as
  folders, Gmail All Mail is synced, and its Important and Starred folders
  are skipped. A message Gmail keeps in several folders is counted once.
- **All accounts** merges Inbox, Sent, Drafts, Spam, Archive and Trash
  across accounts (Gmail All Mail does not count as Archive).
- Read, unread and flags sync with the server both ways. Select several
  conversations to mark, flag, archive, delete or **Move to…** a folder of
  the same account at once.
- **Details** shows a message's headers and MIME structure as text.
- Download a message as .eml or its attachments through a one-time link
  valid for 60 seconds. The plugin does not keep the files, refuses messages
  over 50 MB or changed on the server, and saves risky types such as HTML as
  plain binary files.
- Gmail-style hotkeys; `?` lists them.
- Images that are part of a message show (mail synced before this version
  shows them only once it is fetched again, not automatically). Remote
  images stay hidden until you click **Show images** for that message or
  **Always show from** its sender.
- **Hand to agent** opens a new thread draft that mentions the open message,
  and an `@` mention under **Mail** adds a message's text to any prompt.

## Agent access

The tools `mail_search` and `mail_read` and the `mail` skill are off until you
turn on the setting `agentTools`, which also gates `bb makosh-mail accounts`,
`search` and `read` inside agent threads. They search all folders and name
the folder of each message. Mentions and Hand to agent work without it,
because you pick the message. The CLI also has `sync`, and `remove`, which
works only in your own terminal. No tool, command or mention marks, flags,
moves or downloads mail.

`agentTools` controls what agents are offered. It is not a barrier against an
agent that has shell access to the machine running the BB server: such an
agent can also reach the plugin's internal calls, including the ones behind
the read, flag, move, image and download buttons.

Text handed to an agent (a mention, Hand to agent, or the tools) is sent to
that agent's model provider.

## What it changes on the server

Opening a message or Mark read marks it read; Mark unread and the star
change read state and flags. Spam, Not spam, Archive, Delete and Move to…
move mail. All of these happen only on your click or key. Details and
downloads never mark mail read. Delete moves to Trash; nothing is ever
permanently deleted. Moves work only on servers that support `MOVE` or
`UIDPLUS`. A refused move is retried; after 3 refusals it is cancelled, the
mail goes back to its folder and the account shows the error.

## What it costs

- An app password per account. Gmail needs 2-step verification for one, and
  Google Workspace admins may disable app passwords.
- Mail and credentials stay on the machine that runs the BB server. Passwords
  are encrypted with a key kept in the plugin's secret settings.
- Once you allow a sender's images, opening their mail loads images from the
  web, which tells the sender's servers that you opened it.

## Not yet

Sending, replying, creating or renaming folders, and Gmail API or OAuth
sign-in.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
