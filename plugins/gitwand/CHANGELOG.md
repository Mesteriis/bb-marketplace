# Changelog

## 0.1.0 — unreleased

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
