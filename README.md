# Makosh for BB

Plugins of the Makosh family for [BB](https://github.com/get-bb/bb), the agent
IDE. They bring personal communication into the IDE: you read and answer it
beside your threads, agents get scoped access to it, and a message can become
the start of an agent's work.

[Русская версия](README.ru.md)

> **Status: pre-release.** The repository is set up and the first plugin is a
> skeleton. No release tag exists yet, and nothing is listed in the BB
> Community marketplace.

## Plugins

| Plugin | Id | What it does today |
| --- | --- | --- |
| [Makosh Mail](plugins/mail) | `makosh-mail` | Adds a **Mail** page that lists connected mail accounts. It cannot connect an account, and it cannot read or send mail yet. |

## Install

You need BB 0.49 or later.

From a clone:

```sh
git clone https://github.com/Mesteriis/makosh-bb.git
cd makosh-bb/plugins/mail
npm install
bb plugin install .
```

From a release tag, once the first one exists:

```sh
bb plugin install git:https://github.com/Mesteriis/makosh-bb.git@^0.1.0 --plugin mail --tag-prefix mail/
```

Or through the Makosh marketplace, which lists every plugin of this
repository:

```sh
bb marketplace add git:github.com/Mesteriis/makosh-bb@main
bb plugin install makosh-mail@makosh
```

BB plugins run with full trust. Read what you install.

## Repository layout

```text
.bb/plugins.json     BB collection manifest: the plugins of this repository
marketplace.json     BB marketplace "makosh": store entries and tag ranges
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
