# Contributing

Thanks for looking. This repository holds the Makosh plugins for
[BB](https://github.com/get-bb/bb). It is pre-release, so the fastest way to a
merged change is a small one with a clear reason.

## Before you start

1. Read [docs/architecture.md](docs/architecture.md). Its layering rule is
   enforced by a test, and most review comments come from it.
2. For anything larger than a fix, open an issue first and describe the
   outcome you want.
3. You need Node 22 or later and BB 0.49 or later (`bb --version`).

## Work on a plugin

```sh
cd plugins/mail
npm install
npm run check        # typecheck + tests
npm run build        # bb plugin build → dist/
bb plugin install .  # once, to register the directory in your BB
bb plugin dev        # rebuild and reload on every save
```

From the repository root, `node scripts/check-manifests.mjs` checks the
collection manifest, the marketplace catalog, and the plugin manifests against
each other. CI runs all of the above on every pull request.

## What a change needs

- A test for new behavior. Put mail logic in `src/core` as plain functions so
  it is testable without a BB server; test BB wiring through
  `@get-bb/plugin-sdk/testing`.
- No host imports in `src/core` or `src/ui`. If the core needs something from
  the outside world, declare a port and implement it in `src/adapters/bb`.
- Documentation in the same change when behavior, commands, settings, or the
  store text change. `bb.description`, `PLUGIN_OVERVIEW.md`, and the
  `marketplace.json` entry say the same thing and change together.
- A line under `Unreleased` in the plugin's `CHANGELOG.md`.
- An entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) when you vendor
  or port code. Only bring in code whose license allows MIT redistribution;
  keep its notices, and say where it came from in the pull request.

## Private data

Mail is private. Never put a real address, message body, attachment, token,
or app password into an issue, a test fixture, a screenshot, or a commit. Use
`example.org` addresses and invented text.

## Add a plugin

1. Scaffold it and move it into place:

   ```sh
   cd plugins
   bb plugin new makosh-<name>
   mv bb-plugin-makosh-<name> <name>
   ```

2. In its `package.json`, set `license`, `repository` (with
   `"directory": "plugins/<name>"`), `description` equal to `bb.description`,
   and the `build`, `typecheck`, `test`, and `check` scripts the mail plugin
   has.
3. Replace the scaffold's example code, lay the sources out in the layers of
   [docs/architecture.md](docs/architecture.md), and copy
   `tests/architecture.test.ts` from the mail plugin.
4. Register it: add `{ "name": "<name>", "source": "./plugins/<name>" }` to
   `.bb/plugins.json`, an entry with `"tagPrefix": "<name>/"` to
   `marketplace.json`, an icon under `icons/`, a row in both READMEs, and an
   `npm` block for the directory in `.github/dependabot.yml`.
5. Run `node scripts/check-manifests.mjs` until it passes.

## Pull requests

Keep one concern per pull request, describe what changed and how you checked
it, and expect review on correctness, the layering rule, and private data.
Releases are cut by the maintainer; see [docs/releasing.md](docs/releasing.md).

By contributing you agree that your contribution is licensed under the
repository's [MIT license](LICENSE). Conduct is covered by
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
