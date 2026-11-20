# Changelog

All notable changes to Makosh Mail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Release tags are `mail/vX.Y.Z`.

## [Unreleased]

### Added

- **Dictation**: a Dictate button in the composer records, BB's voice
  service turns the recording into text, the text goes in at the cursor.
- **Smart send**: Send later offers the hour the recipient usually
  writes. **Insights** in the sender card: when they write, how fast each
  side answers, who else is on their mail. Counted locally, no model. New
  RPC method `smart_send_time`; `sender_card` carries `insights`.
- **Ask with actions**: under an answer the model may offer up to three
  buttons — show a search, reply or write with drafted text, archive / mark
  read / flag cited Inbox messages (with Undo). Nothing runs without your
  click; nothing destructive can be offered. The `ask` result carries
  `actions`.
- **AI sorts the inbox** (off by default): one line and your own AI
  labels for each new Inbox message; a label can archive automatically
  (never mail from people you write to, flagged or warned mail; at most 50
  an hour). The line replaces the snippet in the list; `ai:<label>` in
  search and Inbox tabs. Setting `aiSort`; Mail settings → AI features →
  Sorting. New RPC methods `ai_labels_list`, `ai_label_save`,
  `ai_label_delete`, `ai_label_move`; conversations and messages carry
  `aiSummary` and `aiLabels`. Storage migration 24 (`ai_labels`,
  `message_ai`).
- **AI writes mail**: **Write with AI** in the composer (toolbar button,
  Ctrl/Cmd+J) writes the body from a few words, in a reply reading the
  conversation; **Insert** replaces your own text in one step. It follows
  your instructions, uses your facts and matches your voice from your own
  sent text. A link or address you did not write is replaced by
  `[link removed]`. The line above a quote ("On …, X wrote:", the forwarded
  header) is no longer part of your own text for Improve and Write: it is
  not sent to the model and not replaced.
  **Draft replies to new mail** (off by default) drafts a reply to each new
  Inbox message from people you write to; **Reply drafted** under the
  message offers Use and Dismiss; at most 10 an hour and 50 a day; nothing
  is sent without you. Settings `aiVoice`, `aiAutoDrafts`,
  `aiInstructions`, `aiKnowledge`. `ai_start` takes kind `write`; new RPC
  methods `reply_draft_get`, `reply_draft_dismiss`. Storage migration 23
  (`reply_drafts`).
- **Typing speed** in the composer: templates carry a subject, To/Cc/Bcc
  and files and fill `{first_name}`; `;` and a few letters pick a template
  in the body; autocorrect (your own replacements, common English and
  Russian slips, sentence capitals; Backspace undoes a fix); autocomplete
  of phrases from your own sent mail and templates as grey text (Tab);
  a reply quotes only the text you selected; Ctrl/Cmd+Shift+I moves the
  introducer to Bcc with a thank-you line. Settings `autocorrect`,
  `autocorrectPairs`, `autocomplete`. New RPC methods `phrases_list`,
  `template_file_begin`, `template_file_finish`, `template_file_remove`,
  `template_apply`; `template_save` takes `subject`, `to`, `cc`, `bcc`;
  `compose_prepare` takes `quote`.
- **Split Inbox**: tabs over the Inbox, each a search condition applied to
  Inbox conversations, with unread counts, a library of ready tabs (VIP,
  Team, People, Dev, Newsletters, Notifications, Calendar, Attachments,
  nine tools, Other), `]` and `[` to switch, an address per tab
  (`v/<view>/s/<tab>`) and a **Tabs** group in Mail settings → Inbox. A
  conversation is in every tab it matches; at most 12 tabs, one set for all
  accounts. New RPC methods `inbox_tabs_list`, `inbox_tab_save`,
  `inbox_tab_delete`, `inbox_tab_move`; `threads_list` takes `tabId`.
- Search operators `from:vip`, `from:team`, `from:known`, `is:dev`,
  `is:automated`, `is:newsletter` and `has:invite`, in search and saved
  searches too.
- Mail settings are a page inside Mail (the gear in the mail rail, address
  `settings/<section>`): five groups in a side menu, fourteen sections, a
  section select in a narrow panel. The twelve-tab dialog is gone. Two new
  sections: **Mailboxes and sign-in** (how each account signs in, replace a
  password, switch to Google, SMTP settings, the settings of sync) and
  **Local data**. About thirty settings now change on the page instead of
  BB's plugin settings, saved as you change them; the three switches that
  widen what agents may do are shown there and still change only in BB's
  plugin settings. New RPC methods `settings_get` and `settings_set`.
- Google sign-in for Gmail accounts. **Sign in with Google** in the account
  form opens Google in the browser; sync and sending then use an access
  token over IMAP and SMTP instead of an app password. An existing Gmail
  account switches in Mail settings and keeps its mail. A revoked grant
  stops the account with "Sign in to Google again". The Google desktop
  client ships with the plugin (`google-oauth-client.json`). New RPC
  methods `google_sign_in_start` and `google_sign_in_status`; database
  migration element 19 adds the credential kind of an account.
- Local archive (slice 3p). `bb makosh-mail archive add <file>` reads an
  mbox file, an `.eml` file or a folder of `.eml` files into a local
  archive, apart from every mailbox and never uploaded. The **Local
  archive** page lists, searches and opens its messages read-only;
  attachments are read from the source file. No agent surface reads an
  archive. Database migration 18.

- Export (slice 3o). `bb makosh-mail export <accountId> <folder> <file>`
  in the owner's terminal writes a folder from the mail server as one mbox
  file or, with `--format eml`, a directory of `.eml` files; read-only, and
  never over an existing file.

- Subscriptions (slice 3n). Mail settings → Subscriptions: the mailing
  lists of the stored mail with message counts, and unsubscribing from up
  to 10 at once. Each request is the message's own Unsubscribe, shown
  before it is sent; nothing new is stored.

- Filters (slice 3m). Mail settings → Filters: a filter matches new Inbox
  mail by sender, sender domain, mailing list or subject words and moves
  it to a folder, the archive or Trash, marks it read or flags it. The
  first matching filter applies; blocked senders, the owner's own mail and
  messages whose sender check failed are never sorted. Database migration
  17 (`mail_filters`).

- Send later, important senders and calendar invitations (slice 3l).
  **Send later** in the composer picks the time a message goes out; it
  waits in the Outbox as "Scheduled for …", carries that time as its Date,
  and is sent by the BB server while BB runs (under a day late after a
  restart it still goes; later it is held). The `importantSenders` setting
  names addresses and domains whose mail toasts through quiet hours, and
  `notifyImportantOnly` limits toasts to them. A message with a calendar
  part shows the event (what, when, where, who), and Accept, Maybe and
  Decline send the answer to the organizer through the Outbox with Undo.
  Database migration 16 (`outbox.scheduled`). No new dependency.

- OpenPGP (slice 3k). A key pair for a sending address is made in Mail
  settings and kept sealed with the credential key; a backup leaves locked
  by a passphrase. Public keys of other people are pasted in or saved from
  a message. The composer signs and encrypts (PGP/MIME) on request; an
  encrypted message is opened for one view and never stored; a signed one
  is checked against the saved keys. New dependency: `openpgp` 6.3.2
  (LGPL-3.0-or-later). S/MIME stays recognised only.

- Reliability, layout and language (slice 3j). Sync rethreads an account
  only when messages were inserted or deleted, and rewrites only the
  conversations they touched. List rows far from view are not laid out or
  painted, and the next page loads as the end scrolls near. A send that
  never reached the server retries on its own for 24 hours (new Outbox
  state "Not sent yet"); an account with no outgoing server fails at once.
  The header's status opens Mail status; a lost network is a quiet
  "Offline" for 30 minutes before it becomes a banner, and sync problems
  are shown in words. `bb makosh-mail doctor` and `backup` in the owner's
  terminal. Settings for list density, the reading pane below the list and
  the language of Mail's pages; Mail's pages in Russian.

- Security and privacy (slice 3i, part A). A sender check from the
  provider's own `Authentication-Results` (trusted ids only: Gmail; iCloud
  "Not checked" until its id is pinned live; the topmost trusted header,
  worst result per method, DMARC for the From domain only; more than one
  sender in From, a result that cannot be read in full or DMARC only for
  another domain counts as failed), shown as a
  "Sender not verified" strip and, for a pass, only in **Details** with
  **Check again**; never a "verified" badge. Warnings for a foreign
  Reply-To (also in **Before you send**), a lookalike of a domain you write
  to, mixed alphabets and a name that shows another address. A failed
  sender gets no mail rule, no Dev class or alert and no automatic images;
  lookalike and name warnings also hold automatic images, and the image bar
  says why. Older mail is checked on open with a read-only header fetch
  (`sender_check_refresh`, owner only). Agent and BB text get "Sender
  check: failed" / "Sender warning: …" after From.
- Trackers (pixels by size or inline style, and a short list of
  open-tracking hosts) are removed even when images are allowed, and
  counted on the image bar. Links lose tracking parameters and unwrap
  Google, SafeLinks and Facebook redirects (`cleanLinks`, on), everywhere
  Mail shows or prints them and always for agents; a status line shows the
  real address, and a link whose text names another site, whose host mixes
  alphabets or that imitates a known domain opens after a dialog (known
  tracking redirects and punycode-only hosts get a note only).
- Read receipt requests are shown and never answered. PGP and S/MIME mail
  gets a neutral Signed or Encrypted chip; encrypted bodies are never
  stored, indexed or handed to an agent, model or BB. SQLite
  `secure_delete` (and the FTS `secure-delete` option where available)
  overwrites deleted mail in the database file. Migration element 14 adds
  three message columns.
- Apple Mail keys and reading flow (slice 3i, part B). Down/Up open the
  next or previous conversation (cursor only in one column with nothing
  open; a held arrow opens on release), Shift+Down/Up extend the selection,
  Up/Down move between message headers, Backspace and Delete delete. On a
  Mac: ⌘R, ⇧⌘R, ⇧⌘F, ⌃⌘A, ⇧⌘J, ⌃⌘M, ⇧⌘U, ⇧⌘L, ⌥⌘F, ⌘Z, ⌘Backspace and
  ⇧⌘D to send in the composer; no chord BB owns is taken, and ⌘R, ⇧⌘R and
  ⌘Z are subject to the live check. After Archive, Delete, Spam, Not spam,
  Move, Snooze or a drag to a folder of the open conversation the next one
  opens; Undo reopens it. Earlier read messages wait in one closed "N
  earlier messages" stack. Keys typed inside a message body reach the page.

- Search, older mail, folders and attachments (slice 3h). Gmail-style search
  operators with `-` negation (`to:`, `cc:`, `has:attachment`, `filename:`,
  `in:`, `account:`, `is:`, `larger:`, `smaller:`, `newer_than:`,
  `older_than:`, `list:`, `category:`, `label:`), also for `mail_search`.
  **Search on the server** (read-only, Gmail search on All Mail, IMAP
  `SEARCH` elsewhere, 50 hits at a time, Cancel); unopened hits expire after
  `serverSearchKeepDays`. Saved searches with unread counts in the rail.
- **Load 30 more days** per folder (`historyStepDays`), **Load the whole
  conversation**, **Forget older mail**; loaded mail is checked daily. Jobs
  never add mail newer than the last sync round.
- Folder **New folder…**, **New subfolder…**, **Rename…**, **Subscribed**
  and **Delete…** (only at 0 messages, after an optional move to Trash;
  never expunged; a Gmail label folder loses the label only); names read as system folders
  are refused. Drag conversations onto rail folders. Gmail labels as chips,
  **Labels…** (`l`) with per-message Undo.
- Attachment viewer for images, text and PDF (pdf.js 6.5.438 in a `blob:`
  worker, download-only when the page refuses it); SVG and other types are
  download-only. **Files** view (`g f`). Opt-in local search inside text and
  PDF attachments (`indexAttachmentText`, off; PDF text in a resource-limited
  worker thread), for the owner's own searches only.
- Hidden quoted text (`hideQuotes`), **Expand all** / **Collapse all** (`;`),
  **Group by conversation** per folder, plain text (`mailView`), dark mail
  (`darkMail`) with **Original colors**, a sender card, local **Related**
  mail, and **Print…** (Shift+P) without remote images or **Save printable
  page**.
- BB integration (slice 3g). **New thread…** (Shift+N) starts a BB agent
  thread from a message or conversation after showing the exact prompt and
  the project's permission mode; **Edit in composer** opens BB's composer
  with it. **Make a task…** (Shift+K) on a Makosh Taskboard board, or in
  Mail's Tasks with a note when Taskboard does not answer.
- **Save to project…** and **Save all to project…**: attachments written as
  new files inside a project's working tree (`attachmentFolder`), mode
  0644, never into `.git` or a dot folder, with Keep both, Replace (only the
  file shown) or Cancel when a name exists; agent instruction and shortcut
  names get `.txt`. **Attach from BB** in the composer picks up to 10
  project or thread files, asks again for secret-like names, and the
  pre-send check lists them and warns about secret-looking text.
- **Email the result** (thread menu) and **Email this** (assistant
  messages) make a Mail draft from a BB thread, a reply when the thread
  started from a mail. Nothing is sent.
- **Dev** view (`g n`) of GitHub, GitLab, CI and monitoring mail by
  repository, recognised locally at sync (`devNotifications`), with Mark
  read and Archive, **Hide dev notifications** and a Dev line in Today.
  Repository, PR, issue and CI links listed by URL with their project.
- Code, diffs and logs in mail render with BB's highlighter and diff viewer;
  HTML `<pre>` blocks show as "Code (N)". The composer keeps code blocks and
  inline code (toolbar **Code block**, ```` ``` ```` + Enter, fenced paste).
- Patches: review per file with warnings and refusals, **Save .patch to
  project** (`patchFolder`), **Apply with an agent** in a new managed
  worktree. Alerts: **Open incident thread** once per alert, **Add to
  incident thread** for a later mail.
- Project binding: the **Project** chip and binding rules, a **Projects**
  view, and a **Mail** section in a BB thread's Info tab.
- **Mail rules** (`mailRules`, off by default): prepare a thread for review
  in the Inbox's **Ready to start** strip, or start one in a worktree with
  accept-edits after an explicit confirmation; capped, paused with Undo,
  and with no mail tools in rule threads.
- Settings `devNotifications`, `mailRules`, `attachmentFolder`,
  `patchFolder`, `taskTarget`; Mail settings gain **BB integration** and
  **Rules**. Migration element 11 adds the dev columns, `list_id`, BB links,
  bindings, incidents and rule tables.

- Agents and AI (slice 3f). Redaction: every text that reaches an agent or
  a model (tools, the CLI in a thread, mentions, Hand to agent, translation
  and the AI features) has one-time codes, passwords, tokens and card
  numbers replaced by `[hidden …]` placeholders, the whole field before any
  cut. A heuristic, not a guarantee; the README lists what it covers.
- **AI access** in Mail settings: per account all folders, chosen folders
  or none (Spam and Trash never; Gmail by any label or All Mail) and
  **Never share mail from** addresses and domains over the whole
  correspondence. Out-of-scope mail does not exist for agents; Hand to agent
  and the AI buttons say "Outside AI access (Mail settings)".
- **Agent activity** in Mail settings: a local log of every agent tool call,
  mention, Hand to agent, CLI command in a thread and AI call (ids, counts
  and codes only; 90 days, at most 20 000 rows), with a thread filter and
  Clear log. Commands in your own terminal are not logged.
- On your click, through Makosh AI, capped per kind an hour: **Summarize**
  (`Shift+S`) with citations, cached and marked stale after new mail;
  **Ask** (the Search · Ask switch) with linked sources or "Not found in
  your mail"; **Find tasks** (`Shift+T`) with an evidence check and **Keep**
  into the rail's **Tasks** page; **Suggest categories**; **Today**'s
  Summarize; **Improve** in the composer behind a word diff, applied in one
  Undo step and only while your text is unchanged. Model output is plain
  text; only the plugin's citation chips are links.
- Categories (`mailCategories`, off): Bills, Notifications, Personal and
  Newsletters as local labels with suggestions, Accept, Change…, Always for
  this sender, filters and Undo. Nothing is written to the mail server.
- **Today** in the rail: conversations that need a reply, due reminders,
  tasks due and counts since yesterday; with `morningDigest` built once a
  day at `digestTime` and announced by a toast outside quiet hours.
- Reply reminders: **Remind me if no reply in N days** beside Send
  (`replyReminderDays`) and **Remind me…** on Sent mail; answered by
  In-Reply-To or References of a later message, else due in the **Waiting
  for a reply** strip and Today, with a toast. A server that rewrites the
  Message-ID leaves replies unmatched.

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

### Fixed

- A sync round cut short by a plugin reload no longer logs "sync …: error".
- `bb makosh-mail doctor` turns sync back on for an account that was
  stopped by a refused sign-in once the server accepts the saved password
  again.
- One refused sign-in no longer stops an account whose password the server
  has accepted before: sync tries again on its next rounds and stops the
  account only after three refusals in a row. Until then the account shows
  as offline, with a banner after 30 minutes without a good sync.
- A connection that closed before the sign-in is no longer taken for a
  refused password.
- A stopped account comes back by itself: sync tries its saved password
  again with the next full round, then 10 and 30 minutes after a refusal,
  then once an hour, and turns the account on as soon as the server
  accepts it.
- The "update the app password" banner has **Try the saved password**: one
  sign-in with the password Mail already has, without typing it again.

### Changed

- `from:` with a whole address (`from:ada@example.com`) matches that address
  only, and with a domain (`from:example.com`) the domain and its
  subdomains; before, both matched any address containing the text.
- Translation settings are now **AI settings**; `translateProvider` and
  `translateModel` keep their keys with the labels "AI provider (Makosh AI)"
  and "AI model". Translation sends redacted text and restores the hidden
  values in what you read; out-of-scope mail is not translated.
- The makosh-ai adapter reads `ai.v1.providers` in its real shape, keeps an
  unavailable provider's reason and maps `<reason>:` refusals.
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
