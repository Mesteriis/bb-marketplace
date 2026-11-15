# Changelog

All notable changes to Makosh Mail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Release tags are `mail/vX.Y.Z`.

## [Unreleased]

### Added

- Agent tool `mail_contacts`, offered while `agentTools` or `agentPropose`
  is on: people the owner corresponds with, matched by name, address, domain
  or the mail exchanged with them, from header addresses only (never from
  message text), with Spam, Trash and bulk mail left out. Sync marks bulk mail
  (mailing-list headers, `Precedence`, `Auto-Submitted`, automated senders).
- Mail synced before the bulk mark gets it in the background: after each
  successful sync round the plugin fetches only `List-Id`,
  `List-Unsubscribe`, `Precedence` and `Auto-Submitted` (read-only
  `BODY.PEEK`, at most 500 messages per account and round) and never
  overwrites a mark sync set. Until then such mail is judged by its sender.
- A new proposal with no account named goes from the account that corresponds
  with its To recipients; only without any history is the agent asked to name
  one.
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
- `mail_propose`, an agent tool off by default behind the new
  `agentPropose` setting (separate from `agentTools`): an agent proposes a
  new message, reply, reply all or forward, and a confirmation card in its
  thread shows the whole message — full addresses with New address, Added by
  the agent and Outside your domains flags, the Bcc row always, hidden
  characters removed and counted, punycode domains, the links in the text,
  the folded quote and the attachments. **Send** (disabled for 1.5 s, until
  new addresses are acknowledged, and until a tall body is scrolled to its
  end) queues exactly what the card showed with the 10 s Undo; **Open in
  Mail** makes it an ordinary draft with a "Started by an agent" badge;
  **Cancel** discards it. The tool never sends. The settled card stays in
  the thread with the live send state and Undo. Agent sends are labelled
  "Agent message" in the Undo toast and the Outbox. Cards are capped per
  thread, in all and per day, and expire after 24 hours; a restart never
  sends.
- **Translate** in the reading pane (key `t`): a plain-text machine
  translation of the open message through the provider and model chosen in
  the Makosh AI plugin, streamed under the header with **Stop**, **Translate
  again**, a language picker and **Show original**. Only the subject and the
  plain text are sent. Translations are cached per message and language
  until **Clear translations** in the new Translation settings, and removed
  with their message or account. Without Makosh AI the button is disabled
  and says why; provider, model, sign-in, quota and refusal failures have
  their own texts. At most 30 translations an hour.
- The `d/<draftId>` page route opens a draft in the composer.

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
- The page bundle (`dist/app.js`) grew to about 640 KB with the TipTap
  editor, the agent card and translation.
- The agent surfaces: the `mail` skill documents `mail_propose`, and that
  the agent never answers the card itself. The note on agents with shell
  access now also covers answering a card (a forged Send, still behind the
  10 s Undo), starting translations and opening a card's view again, which
  breaks the owner's card but sends nothing.
