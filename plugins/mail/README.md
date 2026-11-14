# Makosh Mail

A [BB](https://github.com/get-bb/bb) plugin that brings mail into the IDE:
your mailbox beside your threads, mail access for agents, and a way to hand a
message to an agent.

**Status: experimental.** Plugin id: `makosh-mail`. It reads mail and moves
it only when you click; it cannot send.

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
- Opening a message on the Mail page marks it read on the server. Reads and
  your moves are the only writes; every other fetch uses `BODY.PEEK`.
- Agent tools `mail_search` and `mail_read` and the `mail` skill, off by
  default behind the `agentTools` setting, which also gates
  `bb makosh-mail accounts`, `search` and `read` inside agent threads. They
  search all folders and name each message's folder. Agents get no way to
  move mail.
- `agentTools` controls what agents are offered; it is not a barrier against
  an agent that has shell access to the machine running the BB server. Such
  an agent can also call the plugin's RPC methods, including the ones behind
  the move and image buttons.
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

Not yet: sending, replying, creating or renaming folders, attachment
download, Gmail API or OAuth.

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
