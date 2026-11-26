# Changelog

## 0.1.0 — unreleased

- Package skeleton: stdio protocol with `gitwand-bridge`, per-file UI routes,
  sibling-origin iframe URL and the frame component, with tests. No BB
  surface is registered yet.
- Runtime build: `bridge-src` (stdio loop with per-connection terminals and
  watchers, five adapters), patches 0001–0002 pinned in `upstream.lock.json`,
  the dispatcher generator and `scripts/build-runtime.ts`; bridge contract
  tests on the built runtime.
