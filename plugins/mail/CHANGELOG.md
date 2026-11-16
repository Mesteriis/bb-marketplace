# Changelog

All notable changes to Makosh Mail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Release tags are `mail/vX.Y.Z`.

## [Unreleased]

### Added

- Inbox tools (slice 3e). Instant new mail: one read-only IMAP IDLE
  connection per account on the Inbox while BB runs (`instantMail`, on by
  default) starts an Inbox-only sync within seconds of a change.
- New-mail toasts in every BB window for unread Inbox mail from people you
  write to (not bulk, not your own, not blocked, at most 6 hours old): the
  sender's name and address with **Open**, never the subject.
  `notifyNewMail` and `quietHours` (the BB server's clock) control them.
- **Unsubscribe** in the reading pane for list mail (never in Spam or
  Trash), confirmed with the privacy cost: an RFC 8058 one-click POST on
  Gmail when its Authentication-Results vouch for a DKIM signature covering
  the list headers, else an unsubscribe email through the Outbox with Undo
  ("Unsubscribe request", never in Drafts). Then **Archive all from this
  list**, never automatic.
- **Snooze** (`b`, toolbar, selection bar): presets or a date and time; the
  first snooze in an account asks before creating its "Snoozed" folder
  ("Snoozed (Makosh)" on Gmail) or choosing one; mail comes back unread while
  BB runs, with Undo and **Return now**.
- **Block** an address or a domain (not public providers): global rules
  that move matching new Inbox mail to Spam after each sync, optionally with
  the stored Inbox mail; never moves mail you took out of Spam or moved back
  yourself. **Blocked senders** with Unblock and each account's snoozed
  folder in Mail settings → Inbox.
- Quick filters **Unread**, **Flagged**, **Attachments** above the list.
- Agent triage behind `agentTriage` (off by default): `mail_inbox`,
  `mail_read` and `mail_triage` propose up to 50 Inbox actions on a card
  where the owner ticks what runs; the thread row shows what ran with Undo.

- Sending addresses (slice 3d): **Mail settings** (the gear in the mail rail)
  lists each account's own address and the aliases added by hand or from
  suggestions found in inbound mail (`Delivered-To`, `X-Original-To`, To and
  Cc); nothing adds one on its own. From in the composer offers every
  address of every account with SMTP; a reply starts from the address the
  original came to. An alias is not verified: Gmail's rewrite (seen in the
  Sent copy) and iCloud's refusal are shown on the address. A queued send
  keeps its From when the alias is removed.
- Signatures per sending address: at the end of a new message under `-- `,
  above the quote with no `-- ` in a reply or forward. Reply and Reply all to
  own mail leave the old signature out of the quote; Forward keeps it.
  Changing From swaps an unedited signature and keeps an edited one.
- Templates, written in Mail settings and inserted at the cursor from the
  composer's **Templates** button or Cmd/Ctrl+Alt+T. Agents list them with
  `mail_templates` (under `agentPropose`; their text goes to the agent's
  model provider) and name one in `mail_propose`.
- **Before you send**: advisory checks for a mentioned but missing
  attachment (English and Russian), an empty subject, a reply recipient
  outside the conversation and an address never sent to, with Fix and Send
  anyway; nothing blocks a send. The addresses sends went to, Bcc included,
  are kept locally until the account is removed.
- Undo the last action: after Archive, Delete, Spam, Not spam, Move to…, or a
  flag or read change on two or more conversations, a toast offers **Undo**
  for 10 seconds, and `z` undoes the page's last action for 10 minutes. A
  move not pushed yet is cancelled; a pushed one is moved back where the
  message still is. On Gmail an archive is undone with UID COPY, the only use
  of COPY. Gmail labels lost by Delete or Spam are not restored. Undo is
  forgotten on restart.
- The agent's card shows the alias badge, the template name, the signature
  and the check results (as warnings; Send stays enabled).
- Migration element 7: identities, templates, sent recipients, the
  accounts' signature, the drafts' From, the messages' Delivered-To and the
  proposals' template name.

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

- Server writes now also include one `CREATE` per account of the snooze
  folder on the owner's confirmation, and moves by snooze, its return, block
  rules and approved triage items. The one outbound web request is the
  confirmed one-click unsubscribe POST. Nothing more is deleted or expunged.
- The shell-access note now also names `unsubscribe_run`, `block_add`,
  `snooze_folder_create` and answering the inbox-actions card.

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
