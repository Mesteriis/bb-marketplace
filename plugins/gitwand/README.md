# Makosh GitWand

GitWand inside BB: GitWand's own UI in an iframe, driven by GitWand's own Rust
commands running headless as `gitwand-bridge`. The full plan lives with the
maintainer; this file covers the parts in the repository.

## Layout

- `src/core`, `src/ui` — host-agnostic code (see `docs/architecture.md`).
- `bridge-src/` — Rust sources copied into upstream's `apps/desktop/src-tauri`
  at build time: the stdio loop (`src/bridge/mod.rs`), the five hand-written
  adapters (`src/bridge/adapters.rs`) and the `gitwand-bridge` example entry.
- `patches/` — the two patches applied to upstream:
  - `0001-bridge-crate.patch`: `bridge` feature and example in `Cargo.toml`,
    `mod bridge` in `lib.rs`, `not(feature = "bridge")` on the telemetry
    `compile_error!`, and `watch_repo_start_for_label` in `watcher.rs`;
  - `0002-vite-base.patch`: grammars loaded under Vite's `BASE_URL`.
- `upstream.lock.json` — upstream repository, tag, commit and patch hashes.
- `scripts/gen-bridge-dispatch.ts` — generates `dispatch.rs` from
  `generate_handler!` (336 of 341 commands on v3.14.0).
- `scripts/build-runtime.ts` — builds the runtime archive.

## Building the runtime

Needs Node 24 (runs the `.ts` scripts directly), git, Rust (stable) and network
access to GitHub, the npm registry and crates.io. Only the host platform is
built.

```sh
node scripts/build-runtime.ts --tag v3.14.0 \
  --commit 436b9684f096e8edd35b6a36e3b4d3af0fd7e084 --platform darwin-arm64
```

Upstream is cloned into a new directory under `$TMPDIR` and its install and
build scripts run only there. The result goes to `.runtime/` (ignored by git):
`gitwand-runtime-<version>-<platform>.tar.gz` with `bin/gitwand-bridge`, `ui/`,
`LICENSE`, `NOTICES`, `runtime.json` and `MANIFEST.sha256`, the same tree
unpacked, and `current.json` pointing at it.

## Bridge contract tests

`npm run check` includes `tests/bridge-contract.test.ts`, which runs against the
runtime in `.runtime/current.json` (or `GITWAND_RUNTIME_DIR`). Without a built
runtime the suite is skipped with a warning.

- `GITWAND_CONTRACT_NO_PTY=1` skips the terminal and watcher checks. Agent
  sandboxes forbid PTYs and FSEvents, so there they fail without it.
- `GITWAND_KEYCHAIN_TEST=1` adds the Keychain round trip. It writes and then
  deletes the entry `gitwand:test-bb` in the login keychain.
