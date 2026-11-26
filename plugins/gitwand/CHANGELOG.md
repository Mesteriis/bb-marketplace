# Changelog

## 0.2.0 — 2026-11-26

- Repositories dialog inside GitWand (patch 0003, runtime 3.14.0+bb2): the
  **+** menu and the start screen open a searchable list of the local
  repositories under the project folders and the remote repositories of
  every `gh` account (own and organizations) and of `glab` GitLab
  memberships. Cloned remotes open their clone; the others open CloneModal
  with the URL filled in, which still asks for the folder.
- The plugin server answers the dialog's commands (`repo_catalog`,
  `repo_catalog_refresh`) itself, before the bridge: a scan of the roots like
  `find -maxdepth`, `gh api` with each account's own token passed only in
  that call's environment, `glab api`, and a cache of the forge listing in
  the plugin's data directory, fetched again on Refresh only. A source that
  fails keeps its last listing and shows a fixed error, never CLI output.
- Status, Fetch, Pull and Pull requests across repositories in the same
  dialog, on GitWand's own `workspace_status_all`, `workspace_fetch_all`,
  `workspace_pull_all` and `workspace_prs_all`: status in batches of 20 for
  the rows in view or on **Refresh status**; Fetch and Pull on the selection
  or the rows shown, Pull after a confirmation that lists the repositories;
  pull requests for the selection only.
- Settings **Project folders**, **Search depth** and **GitLab hosts**.

## 0.1.0 — 2026-11-26

- Package skeleton: stdio protocol with `gitwand-bridge`, per-file UI routes,
  sibling-origin iframe URL and the frame component, with tests. No BB
  surface is registered yet.
- Runtime build: `bridge-src` (stdio loop with per-connection terminals and
  watchers, five adapters), patches 0001–0002 pinned in `upstream.lock.json`,
  the dispatcher generator and `scripts/build-runtime.ts`; bridge contract
  tests on the built runtime.
- The plugin works with a development runtime: a GitWand tab in each thread
  (header action and command palette) on the thread's working tree, a
  GitWand sidebar page, and a settings section with Restart, Roll back and
  Check for updates. gitwand-bridge runs over stdio under a supervisor;
  the relay keeps channels, terminals and watchers per page connection; the
  `__TAURI_INTERNALS__` shim answers every Tauri plugin command the UI
  bundle names; runtimes install from a signed (minisign) channel with a
  smoke test, keep the previous build and roll back.
- Settings section and tab states on the vendored BB design system; an
  Install button for an available build, so the first runtime can come from
  the update channel; a notice when new UI files need a plugin reload.
- Narrow tab (480-560 px): GitWand's commit panel keeps clear of its dock
  (`/gw/embed.css`).
- Keystrokes to one terminal are sent in order (they arrived reordered when
  each went out as its own request).
- Release tooling: `ci/bb-runtime.yml` (build matrix, signing in a protected
  environment, release), `scripts/make-channel.ts`, and the release channel
  URL and the owner's public key in `src/core/update-source.ts`. The runtime
  archive is packed with GNU tar as well as bsdtar.
- Marketplace installs build: the plugin SDK is a dependency, because a git
  install omits devDependencies and the server bundles
  `@get-bb/plugin-sdk/process` from the plugin's own SDK.

