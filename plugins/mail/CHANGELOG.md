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
  compose, reply, reply all and forward; Cmd/Ctrl+Enter sends.
- **Stop showing** on a message from a sender whose images are always shown.
- While the Mail page is open, BB's sidebar shows the mail rail in place of
  the chat list: New message, the account chooser, folders with unread
  counts and the Outbox. The viewed folder is the page's route
  (`v/all/<role>`, `v/<accountId>/<folder path>`), so back and forward follow
  it; `t/<accountId>/<threadId>` opens a conversation.
- **Compose**, **Reply**, **Reply all** and **Forward**, by the owner only:
  address chips with suggestions from stored mail, a rich-text body (TipTap)
  and attachments by picker, drag and drop or paste, up to 25 MB and 100
  recipients. Reply threads with the original and uses Reply-To; Forward
  carries the original's attachments.
- Drafts saved locally within about two seconds and, on servers with
  UIDPLUS, copied to the account's Drafts folder; without UIDPLUS they stay
  local. A draft from another client opens with **Edit draft**.
- Sending over SMTP with TLS through an outbox: a 10-second **Undo** toast,
  then a background send and a Sent copy (APPEND with the Bcc line; Gmail
  keeps its own copy, without Bcc). At most 10 sends a minute per account,
  Retry, Send again and Send now included.
  The **Outbox** at the top of Sent shows sends not done with only the safe
  actions per state (Undo, Send now, Edit, Retry, Discard, Send again,
  Retry copy, Dismiss); nothing resends on its own. A failed send can be
  edited (the draft comes back) or discarded (send and draft deleted).
- SMTP settings per account: iCloud and Gmail presets (also for accounts
  added earlier), host and port for other servers, and an SMTP dialog that
  tests before saving.

### Changed

- The plugin's server writes are now `\Seen` and `\Flagged` added or
  removed and moves, all on the owner's click or key. Agents gain nothing:
  no tool, command or mention marks, flags, moves, downloads, drafts or
  sends mail.
- The note on agents with shell access to the BB server machine now names
  the internal calls behind read state, flags, moves and download links, and
  sending: such an agent could send. This is an accepted limit; the
  always-visible Undo toast, the Outbox and the 10-a-minute cap limit it.
- Server writes now also include drafts appended to Drafts and sent copies
  appended to Sent. The plugin expunges only its own superseded drafts (or
  the one foreign draft the owner continued, and only when it was read in
  full: body, Bcc, every attachment within the cap, and HTML the editor
  holds without loss; any other stays on the server), one UID at a time, on
  servers with UIDPLUS; nothing else is marked `\Deleted`. Opening a draft
  is not an edit: nothing is written to the server until the owner changes it.
- Drafts synced from the server are visible to `mail_search` and
  `mail_read` like any other message.
- The page bundle (`dist/app.js`) grew to about 600 KB with the TipTap
  editor.
