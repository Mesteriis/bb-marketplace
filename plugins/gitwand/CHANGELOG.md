# Changelog

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

