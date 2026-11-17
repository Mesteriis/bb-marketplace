# Makosh Mail

A [BB](https://github.com/get-bb/bb) plugin that brings mail into the IDE:
your mailbox beside your threads, mail access for agents, a way to hand a
message to an agent, emails an agent proposes for you to send, machine
translation of a message, and AI on your click (summaries, Ask, tasks,
categories, a Today view, reply reminders, Improve), with secrets hidden
from every agent and model, an AI access scope and a local log of what
agents did. On your click it hands mail to BB: a new agent thread or a task,
an attachment saved into a project, a patch or an alert handed to an agent,
and a thread's result back as a draft (see [BB integration](#bb-integration)).
It searches your mail server on your click, loads older mail, manages folders
and Gmail labels, and opens attachments in its own viewer (see
[Search, older mail, folders and attachments](#search-older-mail-folders-and-attachments)).

**Status: experimental.** Plugin id: `makosh-mail`. It reads mail, and
changes it on the server only when you click or press a key: read and unread,
flags, moves, folders you create, rename, delete or subscribe to, Gmail
labels, and the snoozes and block rules you set up, which move mail later on
their own. It sends mail you write through your account's SMTP server,
after a 10-second Undo window. Agents cannot send on their own: with
`agentPropose` on (off by default) an agent can propose an email, and it goes
out only when you press **Send** on its card in that agent's thread.

- Connects IMAP accounts with an app password: iCloud, Gmail or another
  server, TLS only (port 993 by default).
- Syncs every folder of each account on the BB server every
  `syncIntervalMinutes` (default 5), covering the last `syncWindowDays`
  (default 30): system folders (Inbox, Sent, Drafts, Spam, Trash, Archive)
  and your own folders. Gmail labels appear as folders; Gmail All Mail is
  synced, its Important and Starred folders are skipped.
- A **Mail** page in the sidebar: a folder list with unread counts (in BB's
  sidebar while the page is open), thread list, search, unread badge (Inbox
  mail of all accounts) and a reading pane
  that sanitizes HTML. A message Gmail keeps in several folders is counted
  and listed once.
- **All accounts**, the default view when you have more than one account: a
  rail of Inbox, Sent, Drafts, Spam, Archive and Trash merged across accounts,
  then each account's own folders under its address. Archive means the
  folders marked Archive; Gmail All Mail is not part of it and stays under
  the Gmail account. Rows show which account they belong to.
- Read and unread state and flags (stars) come from the server and go back
  to it. The plugin changes them only on your click or hotkey: the star on a
  conversation or a message, **Mark read**, **Mark unread**, or opening a
  message.
- Select conversations with their checkboxes (Shift-click for a range, or
  select the whole page) and act on all of them at once: mark read or unread,
  flag or unflag, Archive, Spam, Not spam, Delete, or **Move to…** any
  selectable folder of the same account. A selection across accounts can
  use an action only where it applies to every account, and cannot use
  Move to….
- Images: inline images that are part of the message (`cid:`, up to 512 KB
  each and 2 MB per message) always show. Mail synced by an earlier version
  has no stored inline images: they show only once that message is fetched
  again, which does not happen automatically. Remote images are hidden; a bar
  offers **Show images** for that message or **Always show from** its
  sender. Only `https:` images load, even when allowed. Tracking pixels
  never load, and a sender whose check failed or who looks disguised gets
  no automatic images (see [Security and privacy](#security-and-privacy)).
- **Spam**, **Not spam** (in Spam only), **Archive** and **Delete** in the
  reading pane move the open conversation's messages in the folder you are
  viewing. Delete moves to Trash; nothing is ever permanently deleted.
  Archive on Gmail moves Inbox copies to All Mail and is offered only in the
  Inbox; on other servers it is offered everywhere but Archive, All Mail and
  Trash. Moves are pushed by the
  sync loop and only to servers that support `MOVE` or `UIDPLUS`; a refused
  move is retried and cancelled after 3 refusals, the mail returns to its
  folder and the account shows the error.
- **Details** on a message shows its headers and MIME structure as plain
  text, with a Copy button.
- **Download .eml** and the attachment buttons save a file through a
  one-time link that is valid for 60 seconds. The plugin fetches the message
  from the server for each download and does not store the bytes. A message
  that changed on the server since the last sync is refused (sync and try
  again), and messages over 50 MB are refused. Files of types outside a short
  list of safe ones (HTML, SVG and scripts among them) are saved as generic
  binary files.
- Hotkeys on the Mail page; `?` shows them all. Slice 3f adds Shift+`s`
  summarize and Shift+`t` find tasks; slice 3g adds Shift+`n` New thread…,
  Shift+`k` Make a task… and `g` then `n` for Dev; slice 3h adds `g` then `f`
  for Files, `l` Labels (Gmail), `;` expand or collapse the conversation and
  Shift+`p` print it. `j` / `k` next and previous
  conversation, `o` or Enter open, `u` back to the list, `/` search, `x`
  select, `e` archive, `#` delete, `!` spam, `s` flag or unflag, Shift+`u`
  mark unread, Shift+`i` mark read, `v` Move to…, `b` snooze, and `g` then `i`, `s`, `d`,
  `t` or `a` for Inbox, Sent, Drafts, Trash or All accounts. Letters follow
  the physical key, so they work on other keyboard layouts. Keys do nothing
  while you type in a field. `c` compose, `r` reply, `a` reply all, `f`
  forward, `t` translate (again: show the original), `z` undo the last
  action; in the composer Cmd/Ctrl+Enter sends, Cmd/Ctrl+Alt+T opens the
  templates and Escape closes. Slice 3i adds Apple Mail's keys beside these:
  arrows, Shift+arrows, Backspace and Delete everywhere, Command chords on a
  Mac (see [Apple Mail keys and the reading flow](#apple-mail-keys-and-the-reading-flow)).
- When a sender's images are always shown, the message says so and offers
  **Stop showing**.
- What the plugin writes on the server: `\Seen` when you open a message or
  mark it read, `\Seen` removed when you mark it unread, `\Flagged` added or
  removed by your star, your moves, your drafts (appended to Drafts) and
  copies of what you sent (appended to Sent, except on Gmail, which keeps
  its own). It expunges only its own superseded drafts: after saving a newer
  copy, after a send or a discard, it removes the previous copy it wrote —
  or the one foreign draft you continued, when it was read in full (body,
  every attachment within the cap, nothing the editor cannot hold; any other
  stays on the server beside your copy) — by UID, on servers with UIDPLUS.
  It never marks anything else `\Deleted`. Details, the .eml and attachment
  downloads and every other fetch use `BODY.PEEK` and never mark mail read.
  Undo of Archive on Gmail adds the message back to the folder it came from
  with UID COPY, never into Trash or Spam (those get a move back); nothing
  else uses COPY. Every other undo is an ordinary move back. Snooze creates
  one folder per account, "Snoozed" (on Gmail "Snoozed (Makosh)"), only when
  you confirm it, and moves snoozed mail there and back; block rules and
  approved triage items move mail like your own buttons. Folders you create,
  rename, delete or (un)subscribe and Gmail labels you add or remove are the
  other writes, each on your click (see
  [Folders](#folders)). Instant new mail, server search and loading older
  mail read through read-only (`EXAMINE`) sessions and write nothing. The one
  outbound web request is an unsubscribe one-click POST you confirmed (see
  [Inbox tools](#inbox-tools-new-mail-unsubscribe-snooze-block-filters)).
- Agent tools `mail_search` and `mail_read` and the `mail` skill, off by
  default behind the `agentTools` setting, which also gates
  `bb makosh-mail accounts`, `search` and `read` inside agent threads. They
  search all folders and name each message's folder. Agents get no way to
  mark, flag, move or download mail: no tool, command or mention does that.
  The one way an agent writes mail is `mail_propose`, behind its own
  `agentPropose` setting (see [Emails an agent proposes](#emails-an-agent-proposes)).
  Drafts synced from the server's Drafts folder, yours included, are
  ordinary messages to `mail_search` and `mail_read`. `mail_search` takes the
  same operators as the search box, over synced and already loaded mail
  only: agents cannot search the mail server, load older mail or search
  attachment text.
- `agentTools` controls what agents are offered; it is not a barrier against
  an agent that has shell access to the machine running the BB server. Such
  an agent can also call the plugin's RPC methods, including the ones behind
  the read, unread, flag, move, image and download buttons, and so can get
  a download link. That now includes sending: such an agent could save a
  draft and send it. This is an accepted limit, not a guarantee. What
  limits it: every queued send shows the "Sending in N s · Undo" toast on
  any open Mail page, the Outbox in Sent always lists sends that are not
  done, and each account sends at most 10 messages a minute (Retry, Send
  again and Send now count too). The same holds for agent proposals,
  translation and the inbox tools: through `bb plugin rpc call` such an
  agent can also run `unsubscribe_run`, `block_add` and
  `snooze_folder_create` and answer an inbox-actions card; the next
  sections say what it means there.
- An `@` mention provider (**Mail**) and a **Hand to agent** button that give
  an agent one message you picked.
- CLI: `bb makosh-mail accounts|search|read|sync|remove`. `remove <accountId>`
  deletes an account and its synced mail and works only in your own terminal,
  never inside an agent thread. The `mail` skill in `skills/mail/SKILL.md`
  documents the agent surfaces.
- Text handed to an agent (a mention, Hand to agent, or the tools) is sent to
  that agent's model provider.

Account passwords are sealed with AES-256-GCM under the `vaultKey` secret
setting, generated on first load. Mail and credentials stay on the machine
that runs the BB server.

Not yet: Gmail API or OAuth, scheduled send, system notifications, semantic
search, export to mbox or .eml archives, writing categories or reminders to
the mail server, and S/MIME signing, checking and decryption (Mail only
recognises such mail; OpenPGP works, see [OpenPGP](#openpgp)).

## Writing and sending

- **Compose** (`c` or the button above the folders), and **Reply**, **Reply
  all** and **Forward** in the reading pane (`r`, `a`, `f`). From is one of
  your accounts; To, Cc and Bcc are address chips with suggestions from
  stored mail. The body is rich text (bold, italic, underline, lists,
  quotes, links). Attach files by picker, drag and drop or paste; pasted
  pictures become attachments. Up to 100 recipients and 25 MB of attachments per message;
  addresses with non-ASCII local parts are refused.
- Reply quotes the original and threads with it; Reply uses Reply-To when
  there is one. Forward carries the original's attachments.
- **Drafts** are saved locally within about two seconds of a change. On
  servers with UIDPLUS a copy also goes to the account's Drafts folder
  (after 30 seconds idle, on close or on **Save draft**), so other clients
  see it; without UIDPLUS drafts stay local only. A draft in Drafts, made
  here or in another client, opens with **Edit draft**; the other client's
  copy is removed only after ours is saved.
- **Send** waits 10 seconds: a "Sending in N s" toast offers **Undo**,
  which brings the draft back. Then the BB server sends it over SMTP with
  TLS and saves the Sent copy. The Sent copy keeps the Bcc line; the
  message on the wire has none. Gmail's own Sent copy does not show Bcc.
- **Outbox**, at the top of Sent, lists every send that is not done and
  offers only what is safe from its state:

  | State | Means | You can |
  | --- | --- | --- |
  | Sending soon | inside the Undo window | Undo |
  | Held | was waiting when BB restarted; nothing sent | Send now, Edit |
  | Sending… / saving a copy | in progress | — |
  | Not sent | the server refused it or could not be reached | Retry, Edit (draft back), Discard (message and draft deleted) |
  | May have been sent | the connection dropped after the message went out | Send again (a second copy may arrive), Discard |
  | Sent; the copy failed | sent, but the copy to Sent failed | Retry copy, Dismiss |

  A send that never reached the server retries on its own: when the
  outgoing server could not be reached, did not answer before the message
  was handed over, or asked to try again later (a 4xx reply). The row reads
  "Not sent yet … Next try at 10:42"; the waits are 1, 5, 15, 30 and then
  60 minutes, and the tries end 24 hours after Send, when the row becomes
  "Not sent". An ok sync round of that account sends the waiting rows at
  once, a few seconds apart, within the same cap of 10 sends a minute.
  **Send now**, **Edit** and **Discard** work on a waiting row. A send that
  may have reached the server, one the server refused, a sign-in or TLS
  failure, and an account with no outgoing server never retry. A Gmail send
  that may have been sent is marked done when it shows up in Sent within 5
  minutes.

### SMTP setup

Sending uses the account's app password, the same one IMAP uses.

| Provider | SMTP | Notes |
| --- | --- | --- |
| iCloud | `smtp.mail.me.com`, 587, STARTTLS | App-specific password from your Apple Account (Sign-In and Security → App-Specific Passwords). |
| Gmail | `smtp.gmail.com`, 465, TLS | App password from your Google Account; it needs 2-Step Verification, and Workspace admins may turn app passwords off. |
| Other | your server's host and port | TLS or STARTTLS only. |

iCloud and Gmail accounts get SMTP from their preset, including accounts
added before this version. An Other account asks for SMTP when added; for
one added earlier, Compose shows **Set up SMTP**, which tests the settings
before saving them. The password is decrypted for one send and never
logged. iCloud and Gmail keep their preset SMTP server. For an Other
account the stored password goes only to its saved SMTP server or to the IMAP server
itself; for any other server (even smtp.<same domain>) the dialog asks for the
account password, which the IMAP server must accept first, and which is
stored only when both servers accept it.

## Sending addresses, signatures and templates

**Mail settings** (the gear at the bottom of the mail rail) lists each
account's **Sending addresses**: the account's own address first, then the
aliases you added.

- **Add address** takes an address and an optional name. **Suggestions**
  lists addresses that look like yours, from mail that reached you with none
  of your known addresses in To or Cc (its `Delivered-To` or
  `X-Original-To`, else a To or Cc address on your account's or provider's
  domain), seen at least twice, with "N messages · last <date>". **Add**
  only fills the form; **Not mine** hides a suggestion for good. Nothing is
  added by sync, an agent or a suggestion on its own. Up to 50 per account.
- The plugin cannot check that your provider lets the account send from an
  alias. Gmail sends from an address it does not know as the account's own
  address ("Send mail as" decides): after the Sent copy syncs, the address
  shows "went out from the account's own address". iCloud refuses an
  address that is not one of its aliases; the send shows the refusal and the
  address is marked. Both warnings also show in the composer's From list.
- Removing an alias is local. A send already queued keeps the From it was
  built with; a draft that used it asks you to choose another From.
- Each address has an optional **Signature** (bold, italic, underline,
  links). A new message starts with an empty line and the signature at the
  end, under a `-- ` line. A reply or forward has it above the quote, with no
  `-- `, so mail clients that fold everything after `-- ` never fold the
  quote. Reply and Reply all to your own mail leave your old signature out
  of the quote; Forward keeps it. When the original has no HTML, only a
  signature under a `-- ` line is found, so one from your own reply (written
  without `-- `) stays in the quote. Changing From swaps an unedited
  signature for the new address's; an edited one stays, with
  **Use <address>'s**. A signature pasted from elsewhere becomes ordinary text.
- A draft's Message-ID is made at the domain of the address it started
  from; changing From later keeps it.
- From lists every sending address of every account with SMTP. A reply
  starts from the address the original came to (Delivered-To,
  X-Original-To, To, Cc), within the same account only.
- **Templates** are named blocks of text (lists and links, no quotes), up
  to 200. In the composer **Templates** or Cmd/Ctrl+Alt+T opens a filtered
  list; Enter inserts the template at the cursor. Alt+T and Alt+Shift+T stay
  BB's model picker.

## Before you send

Send saves the draft and runs these checks; none of them blocks a send:

- an attachment mentioned ("attached", "see the file", "во вложении", "прикрепляю"…) with nothing attached;
- an empty subject;
- on a reply, a recipient who is not in the conversation;
- on a new message or forward, an address you have never sent to;
- on a reply or reply all, a recipient that is the original's Reply-To
  address when it goes elsewhere than the sender ("Reply-To differs from
  the sender: …"; **Fix** marks the address). Slice 3i.

When one applies, **Before you send** lists them. **Fix** takes you to it
(the attachment picker, the subject, the recipient row with the chips
marked), **Send anyway** sends, **Back to editing** (the default, Enter or
Escape) closes it. Cmd/Ctrl+Enter does nothing there. If the check itself
fails, the mail is sent as before. "Never sent to" uses only what is stored
here: your Sent folders and a local list of every address a send went to,
Bcc included, kept until the account is removed.

## Undo the last action

After Archive, Delete, Spam, Not spam or Move to…, a toast "Archived 3
conversations · Undo" stays 10 seconds; a flag or read change on two or more
conversations gets one too. **Undo**, or `z` on the Mail page within 10
minutes and until your next undoable action, takes it back. `z` undoes only
what this page did, never another window's action. The toast says
"Moving back…", then "Undone" or "Undone for 5 of 7 messages" with the
reason (moved elsewhere since, folder gone; not synced yet or server not
reached: try Undo again).

- A move not pushed yet is cancelled; a pushed one is moved back from where
  it went, only for messages still there. Nothing is deleted.
- On Gmail, an archived message is added back to its folder with UID COPY.
  Undoing Delete or Spam moves the message back to the folder it came from
  only: other Gmail labels it had are not restored.
- Undo is kept in memory: a BB restart or plugin reload forgets it. While a
  long sync holds the account, it says "Undo will finish after the current
  sync".

## Apple Mail keys and the reading flow

Slice 3i adds Apple Mail's keys beside the Gmail letters; every letter
keeps what it did. Letters, arrows and Backspace follow the physical key,
so they work on other keyboard layouts.

On every platform:

| Key | Does |
| --- | --- |
| Down / Up | Next / previous conversation, and opens it (like `j` / `k`, which open only when a conversation is already open) |
| Shift+Down / Shift+Up | Extend the selection from the cursor row (grouped lists only, as `x`) |
| Down / Up on a message header or the earlier-messages stack | Move focus to the next / previous header |
| Backspace, Delete | Delete, as `#` |

On a Mac only (the same chords with Ctrl would collide with browser and
system keys on Windows and Linux, where the letters cover them):

| Chord | Does | Letter |
| --- | --- | --- |
| ⌘R / ⇧⌘R | Reply / Reply all | `r` / `a` |
| ⇧⌘F | Forward | `f` |
| ⌃⌘A | Archive | `e` |
| ⇧⌘J | Spam | `!` |
| ⌃⌘M | Move to… | `v` |
| ⇧⌘U | Mark read, or unread when nothing is unread | Shift+`i` / Shift+`u` |
| ⇧⌘L | Flag or unflag | `s` |
| ⌥⌘F | Search | `/` |
| ⌘Z | Undo the last action (outside any field) | `z` |
| ⌘Backspace | Delete | `#` |
| ⇧⌘D | Send, in the composer (with Before you send) | Cmd+Enter |

- **Keys BB keeps.** Mail never binds a chord BB uses: ⌘N (use `c`),
  ⇧⌘N (the Sync button), ⌘F (use `/` or ⌥⌘F), ⌘P (Shift+`p`), ⌘1–⌘9
  (`g` then a letter), ⌘K, ⌘J, ⌘W, ⌘T, ⌘O, ⌘[ and ⌘], ⌘\ and the other BB
  defaults, the ⌃⌘ arrows and Escape (use `u`). Apple's Erase Junk Mail
  (⌥⌘J) is not bound: Mail never expunges by key. ⌘R, ⇧⌘R and ⌘Z stay
  bound until the live check in BB shows whether the desktop app reloads
  the window or runs its own undo on them; a chord that does is removed. In
  a browser tab the browser may keep ⌘R for itself; the letters still work.
- **Arrows open.** In two columns Down and Up open the next conversation
  even when none is open, and opening marks it read, as any open does. In
  one column with nothing open they only move the cursor; once a
  conversation is open they open as in two columns. A held arrow only moves
  the cursor and opens the row it stops on when you release it. Inside the
  message text Up and Down scroll, as the browser does. In Drafts an arrow
  opens the draft in the reading pane, not the composer.
- **Keys stay safe.** No key acts while you type in a field, the composer,
  a dialog, a menu or a list, or while an input method is composing. A held
  chord or Backspace acts once; a second Delete while the first is still
  running is dropped, so it never deletes the next conversation unseen.
- **The next conversation opens** after Archive, Delete, Spam, Not spam,
  Move to…, Snooze, or a drag to a folder of the conversation that is open,
  from the reading pane, a hotkey, an Apple chord or the drag: the row
  below, at the end of the list the row above, and the empty state when no
  rows are left. It opens only while the conversation you acted on is still
  open, and an action that fails leaves it open. Mark unread, Block sender
  and anything a rule or another device does close the conversation as
  before. After an action on a selection the cursor moves to the next
  remaining row and nothing opens.
- **Undo reopens.** Undo (the toast's **Undo**, `z` or ⌘Z) brings the
  conversation back and opens it again when the conversation that action
  opened (or nothing) is still shown; after you opened something else it
  does not. On Gmail an archived conversation added back with UID COPY may
  come back as a new conversation; then nothing reopens.
- **Keys inside a message.** After a click into a message's text the keys
  still reach the page, so hotkeys and Backspace keep working. Enter,
  Space, Tab, arrows, Page Up/Down, Home and End stay with the message:
  Enter on a focused link opens that link (through the link check below),
  never the cursor row.

## Inbox tools: new mail, unsubscribe, snooze, block, filters

**Instant new mail.** While BB runs, each account keeps one more IMAP
connection open on its Inbox (`instantMail`, on by default). It only
watches (`EXAMINE` and IDLE, no writes); a change starts an Inbox-only sync
within seconds. A dead connection is noticed in about two and a half
minutes and reopened with backoff; the 5-minute sync goes on regardless.

**New-mail toasts.** New unread Inbox mail from someone you have written to
(not a mailing list or newsletter, not your own address, not blocked, at
most 6 hours old) shows a BB toast "New mail from <name>" with the address
and **Open**, in every BB window. It names the sender only, never the
subject or text. It is an in-app toast, not a system notification: nothing
shows while BB is closed or hidden behind other apps. No toast while the
Mail page shows an Inbox (the list updates there). `notifyNewMail` turns
toasts off; `quietHours` ("22:00–08:00", may cross midnight) silences them,
by the clock and time zone of the machine running the BB server, so a
remote BB server uses its own hours. Nothing is saved for later. A forged
From naming someone you write to can toast too; the address shown is the
one in the message. A snoozed message that comes back toasts by the same
rule.

**Unsubscribe.** A message with `List-Unsubscribe` gets **Unsubscribe** in
the reading pane (never in Spam or Trash, which says "Use Spam or Block for
mail you never signed up for"). A dialog names the list and the method and
always says the cost: unsubscribing tells the sender the address is read.
- One click (RFC 8058) is offered only on Gmail, and only when Gmail's own
  `Authentication-Results` vouch for a DKIM signature that covers both list
  headers by a domain related to the sender or the link. iCloud gets the
  email method only until its verifier ids are pinned from a live check;
  other servers always get the email. The POST goes to the stored `https`
  link only, port 443, to public addresses only (no local network), with no
  cookies, no redirect followed and the answer's body never read; 5 s to
  connect, 10 s in all; at most one per message per 10 minutes and 30 an
  hour. A redirect says it may not have worked.
- The email goes out from the address the list wrote to, through the Outbox
  with the 10-second Undo, listed as "Unsubscribe request" (no Edit) and
  never saved to Drafts. An unsubscribe address at another domain than the
  sender's is pointed out.
- Afterwards the pane says "You asked to unsubscribe on <date>" and offers
  **Archive all from this list** (an ordinary archive of that list's mail
  in this Inbox). Nothing is archived, blocked or moved by itself.

**Snooze** (`b`, or Snooze in the toolbar or selection bar, Inbox only):
Later today, Tomorrow, This weekend, Next week or a date and time. The first
snooze in an account asks before creating a "Snoozed" folder ("Snoozed
(Makosh)" on Gmail, so it is not mistaken for Gmail's own Snoozed), or lets
you pick an existing folder; Mail settings → Inbox changes it. Snoozed mail
moves there and comes back to where it was, unread, at that time, with
"Snoozed until Tue 08:00 · Undo" and **Return now**. Returns happen only
while BB runs: on your phone it waits in Snoozed, and overdue mail returns at
the next start. Renaming or deleting the folder elsewhere ends those snoozes
(the mail stays where it is).

**Block** a sender's address, or everyone at their domain (not offered for
public providers like gmail.com). It says when you have written to them and
can also move their stored Inbox mail (ticked for an address, unticked for a
domain). Rules apply to every account, are kept on this machine, and move to
Spam, never delete: new Inbox mail from them is moved after each sync (within
seconds with instant mail). Mail you move back into the Inbox yourself, or
out of Spam, is not moved again. "Blocked · Undo" takes a rule back; Mail
settings → Inbox → Blocked senders lists them with **Unblock** (mail already
in Spam stays there).

**Filters.** **Unread**, **Flagged** and **Attachments** above the list
narrow it; each view keeps its own while the page is open, and the open
conversation stays listed until you open another. Search has `is:unread`
instead.

## Inbox triage by an agent

With `agentTriage` on (off by default, separate from the other agent
settings), an agent can list your Inbox (`mail_inbox`), read messages
(`mail_read`) and propose up to 50 actions (`mail_triage`): archive, mark
read, snooze, Spam, unsubscribe or reply. Nothing runs until you decide: a
card "Review N inbox actions" in its thread shows each message as the store
has it (sender, subject, date, account) beside the agent's action and note,
in plain text. Every item starts ticked except Unsubscribe; a snooze in an
account without a snooze folder waits for its own "Create a 'Snoozed'
folder" tick. **Apply N** runs only the ticked items through the same paths
as your buttons; the host's submit shortcut does not apply. A reply item
only lets the agent draft that reply with `mail_propose` (which needs
`agentPropose`); every reply is its own card. The settled row says "Applied
N of M" with skipped and rate-limited items and offers **Undo** (expand the
row) while the undo record lives; unsubscribe requests cannot be undone
there. No agent tool blocks senders, creates folders or applies a batch.
Caps: one card waiting per thread and three in all, six per thread an hour
and 30 a day, a ten-minute pause after three cancelled cards; a card waits
24 hours, and a restart while applying marks it "A restart interrupted
this; check your Inbox". The shell limit above applies: an agent with shell
access can answer the card itself.

## Emails an agent proposes

Off by default. Turn on `agentPropose` ("Let agents propose mail for you to
send"); it is separate from `agentTools`. Then agents in a thread get
`mail_propose`: a new message, a reply, a reply to all or a forward of
a message they found with `mail_search`, `mail_read` or a mention. The body
is plain text; a forward can carry only the original's own attachments.

When you say "write to accounting", the agent looks the address up with
`mail_contacts` (offered while `agentTools` or `agentPropose` is on). It
returns people, not messages: addresses from the From, To and Cc headers of
your stored mail only, never ones written inside a message, matched by word
prefix against the name, the address and domain, and the mail you exchanged
with them. Spam, Trash and bulk mail are left out: a message with
`List-Id`, `List-Unsubscribe`, `Precedence: bulk/list/junk` or an
`Auto-Submitted` other than `no`, or from a no-reply, notifications,
newsletter, mailer-daemon or postmaster address. People you wrote to come
first, then two-way correspondence, then the most recent. Mail synced before
this release gets its bulk mark in the background: after each successful
sync round the plugin asks the server for just those four header fields
(read-only, never marking mail read, at most 500 messages per account and
round), so the mark fills in over a few rounds. Until then, and for a
message no longer on the server, it is judged by its sender address only.
A new message with no account named goes from the account that corresponds
with its To recipients (the one that last received mail from them, ties to
the one that last sent to them); with no history the agent must name one.

With `template` the agent names one of your templates (it lists them with
`mail_templates`, offered under `agentPropose`; that sends the templates'
text to the agent's model provider). The template's text goes into the
message as it is when proposed; a later edit does not change the card. The
sending address's signature is added by the plugin. For a new message the
agent may name one of your aliases; a reply goes from the address the
original came to.

The tool never sends. It freezes the message and shows a card in that
thread with all of it:

- From (with an "alias" badge for an alias), and To, Cc and Bcc rows that are always there ("none" when empty),
  each address in full. A display name the agent made up is dropped; names
  computed from your stored mail stay as secondary text.
- Flags on each address: **New address** (you never sent to it; it needs an
  "I know this address" click before Send), **Added by the agent** (on a
  reply, beyond what Reply or Reply all would address), **Outside your
  domains**, and hidden characters. A non-empty Bcc row is marked "Hidden
  recipients — the others will not see them". Flagged addresses come first
  in their row and are always shown; a row over 10 addresses collapses only
  the unflagged ones to "and N more", with one acknowledgement for the new
  ones on screen.
- Invisible characters (bidi and zero-width marks, every other format
  character, soft hyphens, variation selectors, line separators) are
  removed from what the card shows, with a count; tag characters and
  Hangul fillers in the agent's subject or text refuse the proposal. An
  internationalized domain shows as `xn--` punycode.
- The subject, the body as plain text, the quote of the original (folded),
  "Includes the template «name»", the signature (under `-- ` only on a new
  message), every link in the agent's text, template and signature by host (also ones without `https://`,
  any `scheme://`, and `mailto:`, `tel:`, `javascript:`, `data:` and the
  like by scheme), and the attachments with their full names and their
  extension shown apart.
- **Before sending**: the attachment, subject and outside-the-conversation
  checks, as warnings that never disable Send.
- **Send** stays disabled for 1.5 seconds, until every new address is
  acknowledged, and, when the body is taller than the card, until you have
  scrolled to its end.

**Send** queues exactly what the card showed, through the Outbox with the
same 10-second Undo; the Undo toast and the Outbox say "Agent message".
**Open in Mail** turns it into an ordinary draft, opened in the composer with
a "Started by an agent" badge; what you send from there is your own send.
**Cancel** discards it. Undo (or Edit in the Outbox) on an agent's send also
turns it back into an ordinary draft. The settled card stays in the thread as
a row with where the send stands now, and Undo while it waits (expand the
row). A card waits 24 hours; a BB restart cancels it and never sends.

Caps: one card waiting per thread and three in all, five proposals per thread
an hour and 30 a day, and a one-hour pause in a thread after three in a row
were cancelled or refused.

**The limit you accept by turning it on.** BB does not tell a plugin who
answered a card. An agent whose thread can run shell commands on the machine
of the BB server can read the card (`bb thread interactions show`), call the
plugin's RPC methods and answer the card itself (`bb thread interactions
respond`), so it could press Send for you. It can also start and read
translations (spending your Makosh AI quota, within 30 an hour) and open the
card's view again, which only stops your copy of the card from sending
("Not sent: this card was opened elsewhere; reopen it"): the proposal stays
as it was and the card opens again in the thread. Inside the plugin nothing
else confirms a proposal, and those commands show up in the thread's command
log. What limits a forged Send: `agentPropose` is off until you turn it on,
every agent send waits 10 seconds with an "Agent message · Sending in N s ·
Undo" toast on any open Mail page and Undo on the thread's row, it sits in
the Outbox, and the caps above apply. A BB change that marks answers given by
a person in the app would remove this limit; it has been written up for BB
but not filed.

## Translation

**Translate** in the reading pane (after Forward, key `t`) translates the
message you have open. It needs the Makosh AI plugin; without it the button
is disabled and says so. The first time, **AI settings** (formerly
Translation settings) ask which Makosh AI provider and model to use; nothing
is chosen for you. The same provider and model serve every AI feature below.

Translate sends the message's subject and plain text, never its attachments,
images, addresses or other headers, to the provider you chose in Makosh AI.
The translation streams in under the message header as plain text, labelled
"Machine translation · provider · model · into language", with a picker for
the language, **Translate again**, **Stop** while it runs, and **Show
original**. A model wrote it, so it may be wrong, and the text is never
shown as HTML or turned into links. Messages over 30 000 characters are
translated in their first part, and a long translation can be cut short;
both are noted. When Makosh AI, its route to the provider, the provider or
the model refuses, the block says which, in fixed words.

Translations are kept in the plugin's database per message and language, and
show at once, marked "cached", the next time. **Clear translations** in
AI settings removes them all; they also go when the message or its
account is removed. Only you start a translation: there is no translate tool
for agents, and `mail_read` does not include translations. The translate
calls are open to an agent with shell access as described above (accepted,
within 30 an hour).

Since slice 3f the text sent for a translation is redacted like everything
else (see below), and a message outside AI access is not translated. In the
translation you read, the hidden values come back in place: the provider saw
`[hidden one-time code]`, you see the code. The map that restores them lives
only in the running job and is dropped when it ends.

## BB integration

Slice 3g connects mail to BB's projects, threads and Taskboard. Every step
starts with your click (or a mail rule you made, below), and nothing in it
writes to the mail server, sends mail, runs a command or makes a web request.

- **New thread…** (Shift+`n`): pick a BB project, this message or the whole
  conversation (the latest 10), and an optional instruction. The dialog shows
  the exact prompt the thread starts with, read-only, the project's
  permission mode ("Runs with full permissions" adds "The agent can run
  commands without asking") and how many hidden values and earlier messages
  were left out. **Start thread** starts it in the project's default
  environment and opens it; **Edit in composer** opens BB's own composer with
  that prompt instead. **Also save the attachments** saves them as below.
- **Make a task…** (Shift+`k`): on a board of Makosh Taskboard (its **Take
  into work** then shows the description) when Taskboard answers, else a
  task in Mail's own Tasks with your note and a due date. If Taskboard does
  not answer, the dialog offers the Mail task instead; Taskboard's own
  refusals show as "Taskboard: …". Setting `taskTarget`.
- **Save to project…** on an attachment, **Save all to project…** on a
  message: into the project's working tree, in `attachmentFolder` (default
  `mail-attachments/`) or a folder you type. Mail writes only new files there
  (it reads first and writes only when the name is free), mode `0644`, never
  into `.git` or a folder that starts with a dot, never outside the tree. A
  name that exists asks: **Keep both** (`report (2).pdf`, the default),
  **Replace** (a second confirmation, and only the file the dialog showed:
  a file that changed since is not replaced) or **Cancel**. Shortcut files
  and names agents read as instructions (`AGENTS.md`, `CLAUDE.md`,
  `.cursorrules`, `*.mdc` and the like) are saved with `.txt` added. Mail
  never opens or runs a saved file. Saving is allowed for mail outside AI
  access (it is your file); the other BB actions are not.
- **Attach from BB ▾** in the composer: **From a project…** (search its
  files) or **From a thread…** (the thread Mail runs beside, or a recent
  thread of a project), up to 10 files. The list marks them "from a BB
  project"; a name that looks like it holds a secret (`.env.local`,
  `id_rsa`) asks again. Before you send, the check lists the files from BB,
  and warns when your text looks like it holds a password, token or code.
- **Email the result** in a BB thread's menu and **Email this** on an
  assistant message turn the thread's result or that message into a Mail
  draft (Markdown becomes paragraphs, lists and code blocks). A thread
  started from a mail opens a reply to that mail, decided from Mail's own
  records, never from thread metadata. Nothing is sent until you press Send.
- **Dev** in the rail (`g` `n`): GitHub, GitLab, CI and monitoring mail of the
  last 7 days by repository, with CI failures, the latest failure and the
  project, and **Mark read** / **Archive** with Undo. Recognised on this
  computer at sync from headers, sender and subject (`devNotifications`, on);
  a self-hosted GitLab or Jenkins sender counts only from the host of a BB
  project's remote or with a List-Id of its own domain, and an alert from a
  domain that is not a known monitoring service only with such a List-Id;
  **Hide dev notifications** in the list. Today shows "Dev: N CI failures".
- **Links**: repository, PR, issue, commit and CI links of a message, listed
  by their real URL with **Open**, **Open project** and **New thread…** in the
  project whose remote matches.
- **Code**: code, diffs and logs in plain mail show with BB's highlighter and
  diff viewer (a plain `<pre>` where BB does not offer them), each with
  **Copy**; an HTML mail's `<pre>` blocks show under it as "Code (N)". The
  composer has **Code block** (or ```` ``` ```` and Enter), and a pasted fenced
  block becomes one.
- **Patches**: a `.patch` / `.diff` attachment or a `git format-patch` body
  shows "Patch · N files · +a -r · Review". The review lists each file's diff
  and warnings (executable files, symlinks, CI workflows, hooks, lock files,
  agent instruction files); a patch that touches `.git`, absolute or `..`
  paths, or more than 200 files is refused with no action. **Save .patch to
  project** writes it as above (`patchFolder`, default `mail-patches/`).
  **Apply with an agent** uploads the patch to a new thread in a fresh
  managed worktree with a fixed instruction (`git apply --check` first, no
  commit, push or scripts); Mail never applies a patch itself. When BB cannot
  make a worktree, the dialog offers your checkout only after a warning.
- **Alerts**: a Grafana, Alertmanager, Sentry, PagerDuty or Datadog mail shows
  the alert's name, state, service and links; **Open incident thread…**
  starts one thread per alert, and a later mail of the same alert offers
  **Add to incident thread** for 7 days.
- **Projects**: the **Project** chip binds a conversation to a project
  (**Always for** its sender, domain or repository adds a binding rule; a
  suggestion from the mail's links is never bound by itself). **Projects**
  in the rail lists each project's mail; a BB thread's Info tab shows a
  **Mail** section with the project's latest bound conversations and those
  the thread came from.
- **Mail rules** (Mail settings → Rules, `mailRules`, **off by default**):
  "when new Inbox mail matches … → in project … with this instruction". Only
  mail that a regular sync round brought into the Inbox counts, never a
  backfill, a first sync or old mail. A rule **prepares** a thread by
  default: it waits in the **Ready to start** strip of the Inbox for your
  **Review** (the New thread dialog) and a toast says so. **Start the thread
  by itself** is a per-rule choice behind a confirmation ("An email from
  anyone matching this rule will start an agent in *project*"); such a thread
  runs in a new managed worktree with `accept-edits` permissions (the agent
  may edit files there without asking, but not in your checkout), never in
  your checkout, and needs a project with a local checkout. Caps: 3 threads
  an hour and 10 a day per rule, 20 a day for all rules, one a day per
  conversation per rule; over a cap the run waits for you. A rule thread
  gets no mail tools, no mail skill and no mail CLI, and stays so (for 180
  days) after its mail, folder or account is gone; the caps keep counting its
  run. A thread whose metadata says a rule started it is treated the same;
  metadata never lifts the restriction. The mail CLI also refuses a call that
  names a project but no thread. **Pause all rules** in the strip and in
  settings, with Undo.

What goes into BB: every prompt, title, task text, incident text and alert
update is built in one place on the server from mail in AI access, with
secrets replaced by `[hidden …]` placeholders over each whole field, quoted
history removed and the mail framed as untrusted data. Thread metadata holds
ids only. The agent log records each hand-off by ids and counts, never a
path, project name, title or prompt. What a thread's agent does with that
text goes to its model provider, as with Hand to agent.

Settings: `devNotifications`, `mailRules`, `attachmentFolder`,
`patchFolder` and `taskTarget` are BB plugin settings (BB Settings →
Plugins → Makosh Mail); Mail settings shows them under **BB integration**
and **Rules**, with the binding rules.

## Search, older mail, folders and attachments

Slice 3h. Everything here starts with your click, runs on the BB server's
machine, sends nothing to an AI provider, and makes no web request. The
new reads go to your own mail server only; the new writes are listed under
[Folders](#folders).

### Search

- **Operators** in the search box (the **?** beside it lists them):
  `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `filename:` (`pdf`
  alone means `*.pdf`), `in:` (a role such as `inbox`, `sent`, `trash`,
  `spam`, `archive`, `snoozed`, or a folder name), `account:`, `is:unread`,
  `is:read`, `is:flagged`, `larger:` / `smaller:` (`10K`, `2M`), `after:` /
  `before:` (`YYYY-MM-DD`), `newer_than:` / `older_than:` (`7d`, `2w`, `3m`,
  `1y`), `list:`, `category:` and `label:`; a leading `-` negates one, values
  with spaces are quoted. A value Mail cannot read stays text and the box
  says so.
- **Search on the server**, below the local hits, sends the query to your
  own mail server: on Gmail as one Gmail search on All Mail (on Trash or Spam
  for `in:trash` / `in:spam`), elsewhere an IMAP `SEARCH` in up to 30
  folders (never Trash, Spam or Drafts unless you name them with `in:`) with
  a 60-second budget per account and **Cancel**. The newest 50 hits not
  already in Mail are fetched (`BODY.PEEK`, read-only, nothing is marked
  read) and shown "from the server"; **More from the server** fetches the
  next 50. `list:`, `category:` and non-Gmail `label:` are local only. A
  server that refuses the search says "This server could not search for this
  text" (non-ASCII text) or "The server refused the search". Unopened server
  hits are removed from Mail after `serverSearchKeepDays` (default 14);
  opening, flagging, moving, replying to, snoozing, labelling or binding
  one keeps it.
- **Saved searches** (up to 50) sit in the rail's **Saved** section with
  their unread count; rename, edit, reorder or delete them from their menu.
- **Search inside attachments** (`indexAttachmentText`, **off by default**):
  after a sync round Mail fetches attachments of synced and loaded mail
  (not Spam, Trash or unopened server hits) and keeps their text in a local
  index: text files (text, CSV, JSON, XML, code, `.ics`, HTML as source) up
  to 10 MB and PDFs up to 5 MB. PDF text is extracted by pdf.js in a
  separate worker thread with memory limits and a 20-second timeout, so a
  bad PDF cannot block or crash the plugin. At most 50 files a round, 200 MB
  of fetching a day and 200 000 characters a file; the whole index stops at
  50 million characters ("Attachment text index is full"). Mail settings
  show the counts, **Retry failed** and **Remove attachment text**. Only your
  own search on the Mail page reads the index: never `mail_search`, the CLI,
  mentions, AI features or BB hand-offs.
- **Related** under a conversation lists up to 10 local conversations that
  share people, a reference or distinctive words, each with its reason. No
  model and no network: it is ranked by local SQL.

### Older mail

- At the end of a folder, **Load 30 more days** (`historyStepDays`, default
  30) fetches up to 500 older messages per step from the server, read-only;
  **Stop** ends a step. A step that had more than 500, or was stopped, runs
  the same days again next time, skipping what is already loaded. In a
  conversation, **Load the whole conversation** looks for its other messages
  (Gmail by the conversation id; elsewhere by Message-ID and References, in
  the conversation's folders plus Sent and Archive), at most 100; they are
  kept like server hits, so unopened ones are removed after
  `serverSearchKeepDays` unless a later step loads their days.
- Loaded mail stays until you choose **Forget older mail** in the folder's
  menu, which removes it from Mail only; nothing changes on the server.
  Flags of loaded mail are checked once a day, so a message deleted on the
  server can stay in loaded history for up to a day.
- A server-search, history or conversation load never adds mail newer than
  the last sync round, and skips a folder that has not synced yet or whose
  UIDVALIDITY changed, so new mail still reaches toasts, rules and triage.

### Folders

The folder menu in the rail has **New subfolder…**, **Rename…**,
**Subscribed** and **Delete…**; the account menu has **New folder…**.
Unsubscribed folders still sync and sit under **More folders**. Each
operation runs on a fresh connection with no folder selected, so nothing is
ever expunged.

- **Create** and **rename** refuse names with control characters or the
  folder delimiter, INBOX, and names your server could read as a system
  folder ("That name is used for system folders"). Inbox, system folders,
  Gmail's `[Gmail]` folders and the snooze folder cannot be renamed or
  deleted. A rename moves Mail's own records (messages, drafts, snoozes,
  folder settings, the AI access choice) to the new path.
- **Delete** of an empty folder is a plain `DELETE` after `STATUS` shows 0
  messages on the same connection. A folder with messages asks first: "Move
  them to Trash first?" moves them with `MOVE` (not undoable with Undo; they
  are in Trash), checks again and deletes only at 0; if mail arrived
  meanwhile it stops with "New mail arrived in the folder; it was not
  deleted". A folder with subfolders is refused.
- **Gmail labels as folders**: deleting one removes the label only. The
  messages stay in All Mail and keep their other labels, so Mail never moves
  them.
- **Residual risk (not Gmail)**: a message delivered to the folder between
  the `STATUS` check and the `DELETE` (one round trip) would be lost with
  the folder.
- **A crash right after a rename**: if the plugin stops between the
  server's answer and moving its own records, the next listing drops the old
  path locally and syncs the new one as a new folder. The sync window comes
  back; mail loaded beyond it, server hits, opened rows and the folder's
  settings are lost locally only. Nothing is lost on the server.
- **Drag** conversations (or the selection) onto a folder in the rail to
  move them; dropping on Trash, Spam or Archive runs Delete, Spam or
  Archive. Undo works as for **Move to…**, and only Mail's own drag from the
  same page is accepted.
- **Gmail labels** show as chips on the message and the list row. **Labels…**
  (`l`) adds or removes labels (`STORE X-GM-LABELS` on All Mail) or creates a
  new one; Undo reverts exactly the labels the change added or removed. A
  refused change makes no Undo.

What the server sees: your search words and the folders and dates you load,
on your own mail server. Server writes added by this slice are only folder
`CREATE`, `RENAME`, `DELETE`, `SUBSCRIBE` / `UNSUBSCRIBE`, `STORE
X-GM-LABELS`, and the `MOVE`s you ask for.

### Attachments and reading

- **The viewer**: clicking an attachment opens it inside Mail. The BB
  server checks the bytes (a type that does not match the attachment's is
  refused) and serves images up to 20 MB, PDFs up to 25 MB and text (the
  first 2 MB). Images show as images, text as text, never as HTML. SVG,
  HTML and every other type are download-only. The page keeps the bytes in
  a `blob:` that it never navigates to and drops on close.
- **PDF** pages are drawn by pdf.js in a `blob:` worker without scripts,
  forms or network requests; links in the PDF are listed by their real URL
  and open only on your click. If BB's page refuses the worker, the PDF is
  download-only with "PDF preview is not available here". Fonts or images
  that need files from the web may not display.
- **Files** in the rail (`g` then `f`) lists every attachment of synced and
  loaded mail with filters for type, sender, account and name, and **View**,
  **Download** and **Open message**.
- **Quoted text** of replies is hidden behind "Show quoted text"
  (`hideQuotes`, on); **Expand all** / **Collapse all** (`;`) opens every
  message of the conversation with its quotes. **Group by conversation** in
  a folder's menu can turn grouping off for that folder.
- **Show plain text** per message, or for all mail with `mailView`. In BB's
  dark mode HTML mail is shown in adapted colors (`darkMail`, `adapt`) unless
  it supports dark mode itself; **Original colors** per message.
- **About** a sender opens a card with counts, recent conversations and
  files, **Search from this sender**, **Files**, **Always show images** and
  **Block…**.
- **Print…** (Shift+`p`) prints a message or the conversation through the
  system dialog (on macOS also **Save as PDF**) from a frame without
  scripts. Remote images are never printed ("Remote images are not
  printed"); where printing is not available, **Save printable page** saves
  the same HTML.

Settings: `historyStepDays`, `serverSearchKeepDays`, `indexAttachmentText`,
`mailView`, `darkMail` and `hideQuotes` are BB plugin settings.

- **Earlier messages** (slice 3i): when a conversation opens, the read
  messages before the first one you need wait in one closed stack, "N
  earlier messages", when there are two or more of them. The message you
  opened, the newest and every message that was unread when the
  conversation opened are never stacked, nor is one you expanded. A click,
  Enter or Space opens the stack; **Expand all** (`;`) opens it with
  everything, **Collapse all** closes it again, and a finished **Load the
  whole conversation** that added messages opens it. The stack names the
  senders and adds "· sender warning" when a stacked message has one. Order
  stays oldest to newest; print, Hand to agent and citations still see every
  message. The single-message view has no stack.

**pdf.js** (`pdfjs-dist` 6.5.438, exact) is the one new dependency. npm may
also install its optional `@napi-rs/canvas` package into `node_modules`;
Mail never loads it (the server worker blocks it) and it is not in the
build. `dist/app.js` contains one inert mention of it in pdf.js's Node-only
code path, which never runs in BB's page.

## Reliability, layout and language

### Big mailboxes

- **Threading.** A sync round groups mail into conversations again only
  when it inserted or deleted messages; a round that changed flags, or
  nothing, skips it. When it runs, only the conversations a message left or
  joined are rewritten. The first round after BB starts rebuilds every
  conversation once, which also repairs rows left wrong by a crash.
- **Lists.** Every loaded row stays in the list, so the keys, the selection
  and drag reach it; a row far from view is not laid out or painted
  (`content-visibility`). The next page loads by itself as the end of the
  list scrolls near; **Load more** stays for a browser that cannot watch
  the list. BB's own find-in-page (⌘F) therefore sees loaded rows only; use
  Mail's search to find a message.
- Tested with 20 000 messages in one account in `npm run check` (50 000
  with `MAIL_SCALE=1`).

### Sync status

- The header's status is a button: **Mail status** lists each account's last
  sync, what is in the way, and its waiting and unsent messages, with
  **Sync now**.
- **Offline.** When the only problem is the network or a busy server and
  the last good sync is under 30 minutes old, the header reads
  "Offline · synced 10:42" and there is no banner; Mail keeps trying. After
  30 minutes, and for any other problem (a refused sign-in, an unreadable
  password, flags or moves that could not be saved), the red banner shows
  the problem in words. "Reconnecting to BB…" means the page itself lost
  its link to BB.

### `bb makosh-mail doctor` and `backup`

Both work only in your own terminal; inside an agent thread they refuse.

```bash
bb makosh-mail doctor              # every account and the database
bb makosh-mail doctor <accountId> --repair-threads
bb makosh-mail backup /full/path/mail-backup.db
```

- **doctor** prints one line per check, `ok`, `warn` or `fail`: the
  database's integrity, sizes and conversation rows; for each account
  whether the saved password can be read, the IMAP sign-in, the outgoing
  server, the known folders, the last sync and its problems, and the
  Outbox. It prints no password, no server reply and no mail. Exit code 1
  when a check failed; `--json` for a script. `--repair-threads` rebuilds
  every conversation from its messages.
- **backup** writes a consistent copy of Mail's database to a new file that
  only you can read. The path must be absolute, its folder must exist, and
  Mail never writes over an existing file. The copy holds your mail text
  and the passwords in their sealed form, without the key; BB's settings
  are not in it. Keep it as private as the mailbox. To restore: quit BB,
  replace the plugin's database file with the copy, start BB.

### Layout

Two BB settings of the plugin: **List rows** (comfortable, or compact with
no preview line; search results stay comfortable) and **Reading pane**
(right of the list, or below it in a wide window; a narrow window keeps one
column).

### Language

**Language of Mail's pages**: same as the system, Russian or English.
Russian covers Mail's own pages, dialogs, toasts and the refusals its
server answers; dates follow the language. These stay English: the labels
of BB's settings, the `bb makosh-mail` commands, what agents read, the
logs, and the words Mail puts into outgoing mail (`Re:`, `Fwd:`, the
"On … wrote:" line). A text with no translation yet is shown in English.
Mail data (subjects, names, folders, labels) is never translated.

## Security and privacy

Slice 3i warns about senders, blocks trackers and cleans links. It adds no
network traffic of its own: no DNS lookup, no link prefetch, no redirect
probe, and nothing written to your mail server.

### Sender check

- **What it reads.** The `Authentication-Results` your own mail provider
  wrote at the top of the message, and only from a provider id Mail trusts:
  Gmail (`mx.google.com`). Mail does not verify DKIM or SPF itself. iCloud
  shows "Not checked" until its provider id is pinned after a live check;
  other servers show "Not checked: Mail does not read this server's
  results". Mail in Sent and Drafts is your own and is not checked.
- **Failed** means DMARC failed for the From domain, or there was no DMARC
  answer and SPF failed with no DKIM pass aligned with From. Only the
  topmost trusted result counts and a fail is never cancelled by a pass; a
  result a sender wrote lower in the headers is ignored. The check also
  fails, saying why, when From holds more than one sender, when the
  provider's result could not be read in full (a value over 64 KB, more than
  20 DKIM results, or a quote or comment left open), or when every DMARC
  result names a domain other than the one in From.
- **No trust badge.** Mail shows warnings only. A pass appears only in
  **Details**, in the provider's words ("Authenticity (from mx.google.com):
  SPF pass … · DMARC pass"); nothing in the list or the header says a
  sender is verified. **Check again** in Details reads the headers again.
- **A failed check** shows "Sender not verified" above the body. It can also
  be a forwarder or an old-style mailing list that rewrites mail (Mail does
  not evaluate ARC), so it means "could not confirm", not "forged".
- **What a failed check stops:** the message never prepares or starts a mail
  rule, gets no Dev class (no Dev entry, no alert card, no rule match on Dev
  fields) and loads no remote images through **Always show from**. Agent
  and BB text get the line "Sender check: failed" after From. Notifications
  are unchanged.
- **Older mail** synced before 3i is checked when you open it: after the
  conversation has stayed open briefly, Mail fetches the header fields of
  its expanded messages once with `BODY.PEEK` (read-only, through the
  account's queue). Nothing is checked in bulk; stacked and collapsed
  messages wait until you expand them.
- **Limits.** The registrable-domain rule is a heuristic, not the public
  suffix list: the last two labels, three under a country second level
  (`example.co.uk`), and three under a short list of shared hosting suffixes
  whose tenants are separate (`github.io`, `onmicrosoft.com`,
  `sharepoint.com` and a few more); a shared suffix not on that list counts
  as one organization. A provider that does not strip a forged result
  carrying its own id from incoming mail would be believed (RFC 8601 says it
  must strip it). **Details** reads the whole header block, so there a
  result the sender wrote under its own headers never counts; the sync and
  the older-mail check see only the header fields they fetch.

### Sender warnings

Under the From line, fixed text with the values shown as data (domains in
their real ASCII form):

- "Replies go to … , not to …" when Reply-To goes to another domain. Before
  you send then lists "Reply-To differs from the sender: …" when a reply
  still goes there.
- "… looks like …, which you write to" for a domain that imitates one you
  sent mail to or your own (confusable letters, or one edit away).
- "This domain mixes alphabets: xn--…" (shown as it really is).
- "The name shows … but the address is …".

A lookalike domain or a name that shows another address, like a failed
check, gets no automatic images. **Show images** for that one message still
works; **Always show** is not offered there and your always-show list is
kept. The image bar says why: "Images from this sender are not loaded
automatically because the sender check failed" (or because the domain looks
like another, the name shows another address, or the sender check has not
run yet; an older message from an always-show sender loads its images once
its check has run).

### Trackers

Tracking pixels are removed even when images are allowed: images at most
2 pixels wide or high (by attribute or inline style), hidden by an inline
style (`display:none`, `visibility:hidden`, `opacity:0`), or from a short
list of open-tracking hosts. The bar says "Images shown · 2 trackers
blocked", or with images hidden that the message has trackers and they stay
blocked; a message whose only remote images are trackers offers no **Show
images**. Limit: an image hidden by a `<style>` class or by a hidden parent
element is not found (Mail does no layout).

### Links

- **Cleaned.** Links in a message, the printed and saved page and the plain
  view lose known tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_eid`
  and similar); the rest of the address is kept byte for byte. Google
  `/url?q=`, Outlook SafeLinks and Facebook `l.php` wrappers are unwrapped
  to the address they carry (one level, read from the URL, never fetched).
  The setting `cleanLinks` ("Remove tracking from links I open", on) turns
  removal and unwrapping off; the checks below stay. A wrapper whose target
  would decode to a control, bidi or space character stays wrapped. Links
  handed to agents and BB (message text, task excerpts, alert links) are
  always cleaned, so an agent that opens one does not confirm a tracked
  open.
- **Status line.** Pointing at or focusing a link shows where it goes at the
  bottom of the reading pane: "→ https://shop.example.com/sale (3 tracking
  parameters removed)", or "→ via tracking redirect at
  click.example-esp.com; Mail cannot see where it ends" for a known
  newsletter click host (Mail never follows the redirect to find out).
- **The dialog.** A link opens only after a dialog when its text names one
  site but it opens another ("This link says www.example.com but opens
  example.net."; invisible characters and the punctuation or arrows around
  the text do not hide it, and a word starting with `https://` or `www.`
  counts anywhere in the text, while a bare name like `report.pdf` counts
  only as the whole text), when its host mixes alphabets, or when it looks like one
  of your own domains or a domain a sender warning in the open conversation
  names. A known tracking redirect and a host that is only in
  punycode (`xn--`) open without a dialog; the status line shows them. A
  link Mail cannot open safely is refused ("This link cannot be opened
  here."). PDF, alert and Dev links pass the same check.

### Read receipts, signed and encrypted mail

- **Read receipts are never sent.** When a message asks for one, the header
  says "The sender asked for a read receipt. Makosh Mail does not send
  receipts." Mail's own mail never asks for one either.
- **S/MIME mail is recognised only.** It gets a neutral chip ("Signed
  (S/MIME)", "Encrypted (S/MIME)"); Mail does not check or open it. An
  encrypted body is never stored: the pane says "This message is encrypted.
  Open it in a mail client that has your key.", agents and BB get
  "[encrypted message — not readable]", and the search and attachment-text
  indexes hold none of it. The ciphertext stays reachable through the
  attachments and **Download .eml**.
- **OpenPGP mail** can be signed, encrypted, checked and opened; see
  [OpenPGP](#openpgp) below.

### OpenPGP

Mail signs and encrypts with OpenPGP (PGP/MIME, RFC 3156) between people
who exchanged keys. Everything happens on this computer.

- **Your key.** Mail settings → **Encryption (OpenPGP)** → **Make a key**
  next to a sending address makes a Curve25519 key pair for it. The private
  half is stored in Mail's database sealed with the same credential key as
  your passwords (`vaultKey`), and is unsealed on the server for one
  signature or one decryption. It never goes to the page, an agent, a model
  or BB, and no log line names a key, an address or a fingerprint.
- **Back it up.** **Back up…** asks for a passphrase of at least 8
  characters and shows the private key locked by it, to copy into a file.
  Mail does not keep the passphrase. Without a backup, losing the database
  or the credential key loses the key, and mail encrypted to it cannot be
  read again. To restore, paste the backup under **Add a key** with the
  passphrase.
- **Other people's keys.** Paste a public key under **Add a key**, or use
  **Save the key from this message** on a signed message that carries one.
  Mail does not look keys up anywhere on the network, and a saved key is
  trusted only because you saved it: compare the fingerprint with its owner
  another way first. Revoked keys are refused; expired keys are not used.
- **Sending.** The composer shows **Sign** and **Encrypt** when the From
  address has a key; both are off until you tick them, for that message
  only. Encrypt needs a saved key for every To and Cc address and refuses a
  message with Bcc (each recipient's key id is visible in an encrypted
  message). The message is also encrypted to your own key, so the copy in
  Sent stays readable to you. **The subject, the addresses and the dates
  are not encrypted**, and a draft's copy on the mail server is not either:
  Mail removes it when the message is sent. Mail an agent proposes is never
  signed or encrypted.
- **Reading.** An encrypted message shows **Decrypt**: Mail fetches the
  message, opens it with your key and shows the text as plain text for that
  view. The text is not stored, indexed or given to agents, AI features,
  search or BB, and it is gone when you leave the message. Attachments
  inside an encrypted message are listed by name only for now. A signed
  message shows **Check signature**: "Signed by a key you saved for this
  sender", "by a key you saved, but not for this sender's address", "does
  not match this message", or "Mail has no key for the signer". A sender
  check from your provider and an OpenPGP signature are separate facts.
- **Limits.** Only PGP/MIME and a body that is one armored block are read;
  clear-signed text is not checked. Mail does not publish your key, does
  not fetch keys (no WKD, no key servers, no Autocrypt), and does not
  rotate or revoke keys. An agent with shell access to the machine that
  runs BB can read the database and the credential key, as with passwords.
- **S/MIME** is not supported: it needs a certificate issued to you by a
  certificate authority, and a self-made one would not be trusted by the
  people you write to.

### Deleted mail on disk

Mail overwrites what it deletes from its database file (SQLite
`secure_delete`), including the search indexes where SQLite supports the
FTS `secure-delete` option (3.42 and later). BB's SQLite version is not
verified: if the option is unavailable, the plugin log says
`secure_delete: fts option unavailable` and the search index may keep words
of deleted mail until SQLite merges it. Copies in the database's WAL file
until the next checkpoint, in backups and in BB's own files are outside
this; the database itself is not encrypted.

## Agents, AI and your secrets

### Redaction

Every text that reaches an agent or a model passes one redaction: the tools,
the CLI in a thread, mentions, **Hand to agent**, translation and every AI
feature below. One-time codes (also split, prefixed, full-width, or under
their label across blank lines as HTML mail lays them out), recovery-code
lists, passwords next to their labels (to the end of the line, or the quoted
text), app passwords and seed phrases, API keys and tokens (GitHub, GitLab,
Stripe, Slack, SendGrid, AWS and Google keys, `sk-` keys, JWTs, PEM blocks,
`Authorization: Basic` and `Bearer` values, long hex and UUID tokens,
secret-looking URL parameters such as `token=` or `code=`, short reset-link
segments and passwords in a URL), card numbers (Luhn-checked) and CVVs next
to a card, and IBANs (checksum-checked, shown as a card number) become
placeholders: `[hidden one-time code]`, `[hidden password]`, `[hidden
token]`, `[hidden card number]`. The whole field is redacted before any cut,
so a secret on a limit is still hidden. Dates, times, amounts, phone numbers,
years, email addresses, zip and error codes, issue keys such as `PROJ-1234`
and commit hashes stay. Agents are told the placeholders are deliberate and never to
ask you to paste a hidden value into the thread; they cannot search for
codes or tokens either (a search matches only text they could read).

Redaction is a heuristic, not a guarantee. It removes the common shapes; a
code written in words, split across lines in an unusual way, inside an image
or in a format it does not know can pass. Images and attachments never
reach any agent or model path.

### AI access

Mail settings → **AI access** sets what agents and AI features may read: per
account **All folders**, **Chosen folders…** (a picker; a folder that no
longer exists is shown as "not found" and shares nothing) or **None**. Spam
and Trash are never shared. On Gmail a message is shared when any of its
labels, or All Mail, is chosen. **Never share mail from** takes addresses
and domains and covers the whole correspondence with them, the mail you sent
them and every conversation they are in included. Outside the scope a message
does not exist for agents: the tools, mentions, the CLI and contacts do not
return or count it, an id of it answers as unknown, and **Hand to agent** and
every AI button on it are disabled with "Outside AI access (Mail settings)".
A change applies to agents at once.

### Agent activity

Mail settings → **Agent activity** is a local action log, always on: every
agent tool call, mention, Hand to agent, CLI command in a thread and AI call
you start writes one row (when, who, which tool, the outcome, how many
items, how many values were hidden, the BB thread, the message ids, and for
AI calls the provider and model setting). It never stores a query, question,
instruction, subject, name, address, snippet, answer or error text; the view
looks the messages up when you open it and marks those that left Makosh Mail.
Rows are kept 90 days (at most 20 000). **Clear log** empties it. Commands in
your own terminal, outside a BB thread, are neither logged nor scoped.

### AI on your click

Every AI feature runs only when you click, through Makosh AI (no plugin
HTTP request), on mail inside AI access, redacted, and with a per-kind cap
an hour (summaries 30, Ask 20, tasks 30, categories 10, Today 10, Improve
30). The answer is shown as plain text, never HTML or links; the only
interactive parts are the plugin's citation chips, which open the messages
it sent. Nothing a model answers labels, keeps, sends or applies anything
without your click. Every block says "AI · provider · model" and "AI can be
wrong; check the cited messages".

- **Summarize** (`Shift+S`): decisions, open questions and deadlines of the
  open conversation with citations. A summary is kept and shown "cached";
  when the conversation got new messages it says so and offers **Summarize
  again**.
- **Ask** (the **Search · Ask** switch above the list): the model turns your
  question into searches, the plugin runs them locally over mail in AI
  access, and the model answers from the excerpts with links to the cited
  messages, or "Not found in your mail". Nothing is kept after you close it.
- **Find tasks** (`Shift+T`): tasks and due dates found in the conversation,
  each with the quote it came from; a quote that is not in the message is
  flagged and left unticked. **Keep** saves the ticked ones to the **Tasks**
  page in the rail (Done, Edit, Delete).
- **Categories** (`mailCategories`, off): Bills, Notifications, Personal and
  Newsletters as local labels only (nothing is written to the mail server).
  Suggestions come from local rules, or from the model when you click
  **Suggest categories** (at most 50 messages of the page); **Accept**,
  **Change…**, **Always for this sender**, filters above the list and a
  "Labelled N · Undo" toast.
- **Today** (the rail): conversations that need a reply (**No reply
  needed**), reply reminders that are due, tasks due and counts since
  yesterday. With `morningDigest` on it is built once a day at `digestTime`
  on the BB server's clock and announced by a toast outside quiet hours; a
  window opened later still shows it once. **Summarize** on Today sends the
  listed conversations to the model.
- **Reply reminders**: **Remind me if no reply in N days** beside Send
  (`replyReminderDays`, 3) or **Remind me…** on a Sent message. A reminder is
  answered when a message (not bulk, not automated, dated after the send or
  up to a day before it, for a skewed clock) refers to the sent one by
  In-Reply-To or References; otherwise it turns due, shows in the
  **Waiting for a reply** strip atop the Inbox and in Today, with a toast.
  A server that rewrites the Message-ID on send (some corporate relays)
  leaves replies unmatched: the reminder then turns due and you dismiss it.
- **Improve** in the composer (Fix mistakes, Shorter, More formal,
  Friendlier, or a one-line instruction) rewrites your own text, the part
  before the quote and the signature, after saving the draft. It shows a
  word diff; **Apply** replaces that part in one step (one Undo) and only if
  you did not change it meanwhile. Bold, italics, underline and links in
  that part are dropped on Apply, and the dialog says so. Hidden values are
  put back in what you apply; the dialog notes one the model changed or
  dropped.

### What goes to your AI provider

Only on your click, only through Makosh AI, only mail in AI access, only
redacted text framed as untrusted data:

- Summarize: subjects, sender display names (the address when there is no
  name), dates and bodies without quotes of the conversation, newest first
  within a cap.
- Ask: first your question alone; then the question and excerpts of up to 20
  messages the local search found.
- Find tasks: the conversation's messages (up to 10) as for Summarize.
- Suggest categories: subject, sender and the first 300 characters of up to
  50 messages.
- Today's Summarize: the latest message of up to 30 conversations, 500
  characters each.
- Improve: your own text of the draft and your instruction.
- Translation: the message's subject and text.
- New thread, Make a task through Taskboard (its **Take into work**), incident,
  patch and rule threads (slice 3g): the text goes into a BB thread or a
  Taskboard task, built as described in [BB integration](#bb-integration);
  the thread's agent then sends it to its own model provider.

Never: recipients' addresses, attachments, images, HTML, folder or account
names. Text handed to an agent goes to that agent's model provider.

### The shell limit

AI access, redaction and the log bind every plugin surface for agents. They
do not bind an agent with shell access to the BB server, which can call the
Mail page's own methods (`ai_start`, `message_body`, `thread_get`, `search`
among them) through `bb plugin rpc call`, as described above. Slice 3g adds
methods that write into BB on the owner's behalf: `attachment_save`,
`bb_thread_start`, `task_from_mail`, `patch_save`, `patch_handoff`,
`incident_start` and `rule_save`. Slice 3h adds methods that change your mail
server: `folder_create`, `folder_rename`, `folder_delete`, `folder_subscribe`
and `labels_change`; methods that fetch from it: `server_search_start`,
`server_search_more`, `history_load` and `conversation_load`; and the owner's
search with `attachments: true`, which reads attachment text. Slice 3i adds
`sender_check_refresh`, which fetches header fields from your mail server
(read-only) and stores the sender check. This is the accepted limit of
slices 3c to 3i, and the skill tells agents not to.

## Mail in the sidebar

While the Mail page is open, BB's sidebar shows the mail rail instead of the
chat list (the panel's experimental `experimental_sidebar`): **New message**,
the account chooser, the folders with unread counts (in All accounts the
merged roles, then each account's folders in a group you can fold) and the
**Outbox** while sends are pending. BB's navigation rail stays; other pages
keep the chat list. There is nothing to turn on. The page itself shows the
search bar, the conversation list and the reading pane or composer; on a
phone-sized window the folders are in BB's sidebar drawer.

The folder you view is the page's route remainder, so BB's back and forward
walk it: `v/all/<role>` for a merged role (`inbox`, `sent`, `drafts`, `junk`,
`trash`, `archive`) and `v/<accountId>/<folder path>` for one account's
folder. `t/<accountId>/<threadId>` opens a conversation and `d/<draftId>` opens a
draft in the composer (what an agent card's **Open in Mail** uses). Ids and
paths are percent-encoded.

## Run it

```sh
npm install
bb plugin install .
```

After editing sources, `bb plugin reload makosh-mail`, or keep `bb plugin dev`
running to rebuild and reload on every save.

## Check it

```sh
npm run check   # typecheck + tests
npm run build   # bb plugin build → dist/
```

## Layout

| Path | Role | May import |
| --- | --- | --- |
| `src/core/` | Domain types, ports, and mail logic | `zod`, itself |
| `src/ui/` | React components that take data through props | `react`, `src/core`, `@/components`, `@/lib`, `@/hooks` |
| `src/adapters/bb/` | BB implementations of the core's ports (SQLite store, imapflow gateway, sync, vault) | anything |
| `server.ts`, `app.tsx` | BB entry points: wire adapters to the core and the UI | anything |
| `components/ui/`, `lib/`, `hooks/` | Vendored BB design-system source | anything |

`tests/architecture.test.ts` fails when `src/core` or `src/ui` imports
something outside its column. The rule keeps the plugin movable to another
host; [docs/architecture.md](../../docs/architecture.md) explains it.

## Store listing

`bb.description` in `package.json` is the short store text and
`PLUGIN_OVERVIEW.md` is the long one. Change them together, and keep
`marketplace.json` at the repository root in step:
`node ../../scripts/check-manifests.mjs` checks all three.
