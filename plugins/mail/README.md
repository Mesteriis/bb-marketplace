# Makosh Mail

A [BB](https://github.com/get-bb/bb) plugin that brings mail into the IDE:
your mailbox beside your threads, mail access for agents, and a way to hand a
message to an agent.

**Status: experimental.** Plugin id: `makosh-mail`. It reads mail and
changes it on the server only when you click or press a key: read and unread,
flags, moves. It cannot send.

- Connects IMAP accounts with an app password: iCloud, Gmail or another
  server, TLS only (port 993 by default).
- Syncs every folder of each account on the BB server every
  `syncIntervalMinutes` (default 5), covering the last `syncWindowDays`
  (default 30): system folders (Inbox, Sent, Drafts, Spam, Trash, Archive)
  and your own folders. Gmail labels appear as folders; Gmail All Mail is
  synced, its Important and Starred folders are skipped.
- A **Mail** page in the sidebar: a folder list with unread counts, thread
  list, search, unread badge (Inbox mail of all accounts) and a reading pane
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
  while you type in a field. The sheet lists `c`, `r`, `a` and `f` for
  compose, reply, reply all and forward as coming later; they do nothing yet.
- When a sender's images are always shown, the message says so and offers
  **Stop showing**.
- What the plugin writes on the server: `\Seen` when you open a message or
  mark it read, `\Seen` removed when you mark it unread, `\Flagged` added or
  removed by your star, and your moves. It never expunges. Details, the .eml
  and attachment downloads and every other fetch use `BODY.PEEK` and never
  mark mail read.
- Agent tools `mail_search` and `mail_read` and the `mail` skill, off by
  default behind the `agentTools` setting, which also gates
  `bb makosh-mail accounts`, `search` and `read` inside agent threads. They
  search all folders and name each message's folder. Agents get no way to
  mark, flag, move or download mail: no tool, command or mention does that.
- `agentTools` controls what agents are offered; it is not a barrier against
  an agent that has shell access to the machine running the BB server. Such
  an agent can also call the plugin's RPC methods, including the ones behind
  the read, unread, flag, move, image and download buttons, and so can get
  a download link.
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

Not yet: sending, replying, creating or renaming folders, Gmail API or
OAuth.

## Mail in the sidebar

The plugin also offers an experimental thread list for BB's sidebar (the
`experimental_threadList` slot). To use it, open Settings → Appearance and
choose **Mail** as the thread list. The sidebar then shows the merged Inbox of
every account (newest first, 50 at a time, with **Load more**) instead of chat
threads; BB's New thread button, search, navigation rows and footer stay.
Clicking a conversation opens it on the Mail page and highlights it in the
list; **Open Mail** opens the page itself. Choose BB's own list again to get
chats back.

The Mail page takes a deep link to a conversation as its route remainder:
`t/<accountId>/<threadId>`, each id percent-encoded.

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
