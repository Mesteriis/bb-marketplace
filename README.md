# BB Marketplace

Personal BB marketplace maintained by [Mesteriis](https://github.com/Mesteriis). Independent plugins retain their upstream identity and licenses. Makosh packages remain a separate family inside this collection.

See [subtree maintenance](docs/subtree-maintenance.md) and [subtrees.json](subtrees.json).

Plugins of the Makosh family for [BB](https://github.com/get-bb/bb), the agent
IDE. They bring personal communication into the IDE: you read and answer it
beside your threads, agents get scoped access to it, and a message can become
the start of an agent's work.

[Русская версия](README.ru.md)

> **Status: pre-release.** The first plugin reads and sends IMAP mail as an
> experimental slice: it marks, flags and moves mail only when you click or
> press a key, and sends only what you write, after a 10-second Undo. No
> release tag exists yet, and nothing is listed in the BB Community
> marketplace.

## Plugins

| Plugin | Id | What it does today |
| --- | --- | --- |
| [Makosh Mail](plugins/mail) | `makosh-mail` | Reads every folder of iCloud, Gmail and other IMAP accounts on a **Mail** page, with an All accounts view, search, read state and flags synced with the server, multi-select with Spam / Archive / Delete / Move to… on your click, .eml and attachment downloads, hotkeys and opt-in agent tools. Composes, replies and forwards with drafts on the server, sends over SMTP with a 10-second Undo and an Outbox. Sending addresses (aliases) with signatures, templates, advisory checks before sending, and Undo (or `z`) for the last move or flag change. Translates a message through Makosh AI. Agents can propose an email; it is sent only when you press Send on its card (off by default). New mail within seconds with toasts for people you write to, Unsubscribe that asks first, Snooze (`b`), Block rules that move mail to Spam, and Unread / Flagged / Attachments filters. With `agentTriage` on, an agent can propose inbox actions; only the ones you tick on its card run. On your click, through Makosh AI: Summarize with cited messages, Ask your mail, Find tasks for a local Tasks list, local categories, a Today view, reply reminders and Improve for your draft behind a diff. Codes, passwords and tokens are hidden before any agent or model sees mail, AI access limits what they read, and Agent activity logs what they did. |
| [Makosh Taskboard](plugins/taskboard/README.md) | `makosh-taskboard` | Persistent local tasks and Jira Cloud / Server / Data Center connections, List and Kanban, filters, descriptions and workflow transitions. |

## Install

You need BB 0.49 or later.

From a clone:

```sh
git clone https://github.com/Mesteriis/bb-marketplace.git
cd bb-marketplace/plugins/mail
npm install
bb plugin install .
```


Or through this marketplace:

```sh
bb marketplace add git:github.com/Mesteriis/bb-marketplace@main
bb plugin install makosh-mail@mesteriis
```

BB plugins run with full trust. Read what you install.

## Repository layout

```text
.bb/plugins.json     BB collection manifest: the plugins of this repository
marketplace.json     BB marketplace "mesteriis": entries tracking main
icons/               Icons the marketplace entries use
plugins/<name>/      One self-contained plugin each (own package.json and lockfile)
scripts/             Manifest and release checks
docs/                Architecture and release process
```

## Develop

Each plugin is developed from its own directory:

```sh
cd plugins/mail
npm install
npm run check        # typecheck + tests
npm run build        # bb plugin build
bb plugin install .  # register it in your BB
bb plugin dev        # rebuild and reload on every save
```

From the repository root, `node scripts/check-manifests.mjs` checks that the
collection manifest, the marketplace catalog, and the plugin manifests agree.

Plugins keep host code at the edge so they can move from BB to another host
without a rewrite. [docs/architecture.md](docs/architecture.md) states the
rule, and a test in each plugin enforces it. [CONTRIBUTING.md](CONTRIBUTING.md)
covers the workflow and how to add a plugin; [docs/releasing.md](docs/releasing.md)
covers releases.

## Security

Mail is private, and mail content is untrusted input for a person and for an
agent alike. Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party code keeps its own notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
