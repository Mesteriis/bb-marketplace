# Changelog

All notable changes to Makosh Mail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Release tags are `mail/vX.Y.Z`.

## [Unreleased]

### Added

- Plugin skeleton: a **Mail** page in the BB sidebar.
- IMAP accounts with an app password: iCloud, Gmail and other servers, TLS
  only. Passwords are encrypted with a key in the plugin's secret settings.
- Mail sync on the BB server every 5 minutes (setting
  `syncIntervalMinutes`), covering the last 30 days (`syncWindowDays`), stored
  in the plugin's SQLite database.
- Mail page: conversation list, search, unread badge, and a reading pane with
  sanitized HTML. Opening a message marks it read on the server.
- Agent tools `mail_search` and `mail_read` and a `mail` skill, all off by
  default behind the `agentTools` setting.
- A **Mail** mention provider and a **Hand to agent** button.
- CLI: `bb makosh-mail accounts`, `search`, `read`, `sync` and `remove`; inside
  agent threads `accounts`, `search` and `read` follow `agentTools`, and
  `remove` works only in the owner's own terminal.
- Every folder of each account syncs: system folders and the owner's own,
  Gmail labels as folders, Gmail All Mail synced, Gmail Important and Starred
  skipped. The Mail page has a folder list with unread counts, and a message
  Gmail keeps in several folders is counted and listed once.
- **Spam**, **Not spam**, **Archive** and **Delete** buttons, by the owner's
  click only. Delete moves to Trash and never deletes permanently. Moves are
  pushed only to servers with `MOVE` or `UIDPLUS`; a refused move is retried
  and cancelled after 3 refusals with an error on the account.
- Inline (`cid:`) images always show for mail synced from this release on;
  mail synced earlier shows them only once it is fetched again, which does
  not happen automatically. Remote images stay hidden, with
  **Show images** for one message and **Always show from** a sender.
- Agent tools, mentions and CLI search all folders and name each message's
  folder.
- **All accounts** view, the default with more than one account: Inbox,
  Sent, Drafts, Spam, Archive and Trash merged across accounts, then each
  account's own folders. Archive takes only folders marked Archive, so Gmail
  All Mail stays under its account.
- Read and unread state and flags sync with the server both ways. The owner
  changes them with the star, **Mark read** and **Mark unread**; the sync
  pushes `\Seen` and `\Flagged` added or removed.
- Multi-select with checkboxes, Shift-click ranges and select page, and
  bulk mark read or unread, flag or unflag, Archive, Spam, Not spam, Delete
  and **Move to…** a selectable folder of the same account.
- **Details**: a message's headers and MIME structure as plain text, with
  Copy.
- .eml and attachment downloads through a one-time link valid for 60
  seconds. The plugin does not store the bytes, refuses messages over 50 MB
  or changed on the server since the last sync, and saves types outside a
  short safe list (HTML and SVG among them) as generic binary files.
  Details and downloads never mark mail read.
- Hotkeys on the Mail page with a `?` sheet: `j`, `k`, `o`, Enter, `u`, `/`,
  `x`, `e`, `#`, `!`, `s`, Shift+`u`, Shift+`i`, `v`, and `g` then `i`, `s`,
  `d`, `t` or `a`. Letters follow the physical key. `c`, `r`, `a` and `f`
  are listed as coming later.
- **Stop showing** on a message from a sender whose images are always shown.
- An experimental **Mail** thread list for the BB sidebar (Settings →
  Appearance → thread list): the merged Inbox of every account in place of
  the chat list. A row opens its conversation on the Mail page, which also
  opens a conversation from a `t/<accountId>/<threadId>` deep link.

### Changed

- The plugin's server writes are now `\Seen` and `\Flagged` added or
  removed and moves, all on the owner's click or key; it still never
  expunges. Agents gain nothing: no tool, command or mention marks, flags,
  moves or downloads mail.
- The note on agents with shell access to the BB server machine now names
  the internal calls behind read state, flags, moves and download links.
