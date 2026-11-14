This experimental release puts your mailbox next to your threads: connect an
iCloud, Gmail or other IMAP account, read and search every folder, sort spam
and archive with a click, and give one message to an agent when you want help
with it.

## What you get

- A **Mail** page in the sidebar with an unread badge, a folder list with
  unread counts, conversation list, search and reading pane. HTML mail is
  sanitized.
- Every folder of each account syncs on the BB server every 5 minutes and
  syncs the last 30 days; both are plugin settings. That covers Inbox, Sent,
  Drafts, Spam, Trash, Archive and your own folders. Gmail labels appear as
  folders, Gmail All Mail is synced, and its Important and Starred folders
  are skipped. A message Gmail keeps in several folders is counted once.
- **Spam**, **Not spam**, **Archive** and **Delete** in the reading pane move
  the open conversation's messages in the folder you are viewing.
- Images that are part of a message show (mail synced before this version
  shows them only once it is fetched again, not automatically). Remote
  images stay hidden until
  you click **Show images** for that message or **Always show from** its
  sender.
- **Hand to agent** opens a new thread draft that mentions the open message,
  and an `@` mention under **Mail** adds a message's text to any prompt.

## Agent access

The tools `mail_search` and `mail_read` and the `mail` skill are off until you
turn on the setting `agentTools`, which also gates `bb makosh-mail accounts`,
`bb makosh-mail search` and `bb makosh-mail read` inside agent threads. They
search all folders and name the folder of each message. Mentions and Hand to
agent work without it, because you pick the message. The CLI also has
`bb makosh-mail sync`, and `bb makosh-mail remove <accountId>`, which works
only in your own terminal. No tool, command or mention moves mail.

`agentTools` controls what agents are offered. It is not a barrier against an
agent that has shell access to the machine running the BB server: such an
agent can also reach the plugin's internal calls, including the ones behind
the Spam, Not spam, Archive, Delete and image buttons.

Text handed to an agent (a mention, Hand to agent, or the tools) is sent to
that agent's model provider.

## What it changes on the server

Opening a message on the Mail page marks it read. Your clicks on Spam, Not
spam, Archive and Delete move mail on the server; agents, mentions and the CLI
never mark, move or delete mail. Delete moves to Trash and nothing is ever
permanently deleted. Moves work only on servers that support `MOVE` or
`UIDPLUS`; elsewhere a move is cancelled at once. A move the server refuses is retried on the next syncs; after 3
refusals it is cancelled, the mail goes back to its folder and the account
shows the error.

## What it costs

- An app password per account. Gmail needs 2-step verification for one, and
  Google Workspace admins may disable app passwords.
- Mail and credentials stay on the machine that runs the BB server. Passwords
  are encrypted with a key kept in the plugin's secret settings.
- Once you allow a sender's images, opening their mail loads images from the
  web, which tells the sender's servers that you opened it.

## Not yet

Sending, replying, creating or renaming folders, attachment download, and
Gmail API or OAuth sign-in.

## Source

Requires BB 0.49 or later. MIT licensed at https://github.com/Mesteriis/makosh-bb,
with parts ported from Velo (Apache-2.0).
