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
  sanitized HTML. Opening a message marks it read on the server; that and
  the owner's moves are the plugin's only server writes.
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
