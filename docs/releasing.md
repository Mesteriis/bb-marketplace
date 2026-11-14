# Releasing

Each plugin is released on its own, from a Git tag named `<plugin>/vX.Y.Z`
(for example `mail/v0.1.0`). BB reads these tags directly: a user who installed
a range such as `^0.1.0` gets the highest tag the range allows, and
`bb plugin update` moves them forward.

A tag is permanent. BB records the commit a tag pointed at and refuses the
plugin if the tag later moves, so fix a bad release with a new version.

## Release a plugin

1. Set the new version in `plugins/<plugin>/package.json` and run
   `npm install --package-lock-only` there.
2. Move the `Unreleased` notes in the plugin's `CHANGELOG.md` under the new
   version and date.
3. If the short description or the surfaces changed, update `bb.description`,
   `PLUGIN_OVERVIEW.md`, and the entry in `marketplace.json` together.
4. If the new version leaves the catalog range (a `0.x` minor bump does),
   widen `source.git.range` in `marketplace.json`.
5. Run the checks:

   ```sh
   node scripts/check-manifests.mjs
   cd plugins/<plugin> && npm run check && npm run build
   ```

6. Commit, merge to `main`, then tag that commit and push the tag:

   ```sh
   node scripts/release-info.mjs <plugin>/vX.Y.Z   # tag and manifest agree?
   git tag -a <plugin>/vX.Y.Z -m "Release <plugin> vX.Y.Z"
   git push origin <plugin>/vX.Y.Z
   ```

The `Release` workflow then repeats the checks on the tagged commit and
publishes a GitHub release with generated notes.

## Where users install from

- **Git, directly.**

  ```sh
  bb plugin install git:https://github.com/Mesteriis/makosh-bb.git@^0.1.0 --plugin mail --tag-prefix mail/
  ```

- **The Makosh marketplace.** `marketplace.json` at the repository root is a
  BB marketplace named `makosh`. It lists every plugin with its tag range, so
  a release inside the range needs no catalog change.

  ```sh
  bb marketplace add git:github.com/Mesteriis/makosh-bb@main
  bb plugin install makosh-mail@makosh
  ```

- **The BB Community marketplace.** A plugin gets there through a pull request
  to <https://github.com/get-bb/marketplace>, prepared with BB's
  `submit-a-plugin` skill. Each entry needs a category, a vendored icon,
  screenshots at least 1200 pixels wide, and a copy of `PLUGIN_OVERVIEW.md`.
  Submit a plugin once it does something a user would install it for; no
  Makosh plugin has been submitted yet.

## Building in CI

CI builds with a pinned BB CLI from npm (`bb-app`, the `BB_APP_VERSION`
variable in `.github/workflows/`). Raise it together with a plugin's
`engines.bb` and SDK pin; `bb plugin types` in the plugin directory syncs the
SDK and the type-only pins to the BB you run locally.
