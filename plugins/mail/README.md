# Makosh Mail

A [BB](https://github.com/get-bb/bb) plugin that brings mail into the IDE:
your mailbox beside your threads, mail access for agents, a way to hand a
message to an agent, emails an agent proposes for you to send, and machine
translation of a message.

**Status: experimental.** Plugin id: `makosh-mail`. It reads mail, and
changes it on the server only when you click or press a key: read and unread,
flags, moves. It sends mail you write through your account's SMTP server,
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
  sender. Only `https:` images load, even when allowed.
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
- Hotkeys on the Mail page; `?` shows them all. `j` / `k` next and previous
  conversation, `o` or Enter open, `u` back to the list, `/` search, `x`
  select, `e` archive, `#` delete, `!` spam, `s` flag or unflag, Shift+`u`
  mark unread, Shift+`i` mark read, `v` Move to…, and `g` then `i`, `s`, `d`,
  `t` or `a` for Inbox, Sent, Drafts, Trash or All accounts. Letters follow
  the physical key, so they work on other keyboard layouts. Keys do nothing
  while you type in a field. `c` compose, `r` reply, `a` reply all, `f`
  forward, `t` translate (again: show the original); in the composer
  Cmd/Ctrl+Enter sends and Escape closes.
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
- Agent tools `mail_search` and `mail_read` and the `mail` skill, off by
  default behind the `agentTools` setting, which also gates
  `bb makosh-mail accounts`, `search` and `read` inside agent threads. They
  search all folders and name each message's folder. Agents get no way to
  mark, flag, move or download mail: no tool, command or mention does that.
  The one way an agent writes mail is `mail_propose`, behind its own
  `agentPropose` setting (see [Emails an agent proposes](#emails-an-agent-proposes)).
  Drafts synced from the server's Drafts folder, yours included, are
  ordinary messages to `mail_search` and `mail_read`.
- `agentTools` controls what agents are offered; it is not a barrier against
  an agent that has shell access to the machine running the BB server. Such
  an agent can also call the plugin's RPC methods, including the ones behind
  the read, unread, flag, move, image and download buttons, and so can get
  a download link. That now includes sending: such an agent could save a
  draft and send it. This is an accepted limit, not a guarantee. What
  limits it: every queued send shows the "Sending in N s · Undo" toast on
  any open Mail page, the Outbox in Sent always lists sends that are not
  done, and each account sends at most 10 messages a minute (Retry, Send
  again and Send now count too). The same holds for agent proposals and
  translation; the next sections say what it means there.
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

Not yet: creating or renaming folders, Gmail API or OAuth, signatures,
aliases and scheduled send.

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

  Nothing resends on its own. A Gmail send that may have been sent is
  marked done when it shows up in Sent within 5 minutes.

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

## Emails an agent proposes

Off by default. Turn on `agentPropose` ("Let agents propose mail for you to
send"); it is separate from `agentTools`. Then agents in a thread get one
tool, `mail_propose`: a new message, a reply, a reply to all or a forward of
a message they found with `mail_search`, `mail_read` or a mention. The body
is plain text; a forward can carry only the original's own attachments.

The tool never sends. It freezes the message and shows a card in that
thread with all of it:

- From, and To, Cc and Bcc rows that are always there ("none" when empty),
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
  every link in the agent's text by host (also ones without `https://`),
  and the attachments.
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
card's view again, which only breaks your copy of the card ("This card was
opened elsewhere; reopen it") and sends nothing. Inside the plugin nothing
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
is disabled and says so. The first time, Translation settings ask which
Makosh AI provider and model to use; nothing is chosen for you.

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
Translation settings removes them all; they also go when the message or its
account is removed. Only you start a translation: there is no translate tool
for agents, and `mail_read` does not include translations. The translate
calls are open to an agent with shell access as described above (accepted,
within 30 an hour).

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
