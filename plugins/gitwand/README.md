# Makosh GitWand

GitWand inside BB: GitWand's own UI in an iframe, driven by GitWand's own Rust
commands running headless as `gitwand-bridge`. The full plan lives with the
maintainer; this file covers the parts in the repository.

## How it runs

- `server.ts` starts `gitwand-bridge` from the runtime in use as a child
  process over stdio (no port, no token), relays the page's calls
  (`POST /gw/invoke`) and channel messages (`WS /gw/ws`, one connection per
  page, channels and terminals bound to it), serves the UI with one GET route
  per file under `/ui/`, and answers the settings and tab RPC.
- The page loads `/gw/shim.js` first: `src/shim/tauri-shim.ts`, shipped as a
  generated string (`src/adapters/bb/shim-source.generated.ts`) so the plugin
  bundler cannot change it. Run `npm run shim` after editing the shim; a test
  fails while the generated file is stale.
- The runtime in use is the **Development runtime directory** setting (or
  `GITWAND_RUNTIME_DIR`), else the installed build under the plugin's data
  directory. Installed builds come from the signed update channel (settings
  **Update channel URL** and **Update signing key**; off while empty).

## Layout

- `src/core`, `src/ui` — host-agnostic code (see `docs/architecture.md`).
- `src/shim` — the `__TAURI_INTERNALS__` shim; imports nothing.
- `src/adapters/bb` — bridge process and supervisor, relay, UI routes,
  runtime store, update channel, minisign verification.
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

## Releasing a runtime

`ci/bb-runtime.yml` is the release workflow for the release repository
(`Mesteriis/GitWand-bb`, copied to `.github/workflows/bb-runtime.yml`). Run by
hand with the GitWand tag and commit from `upstream.lock.json`, a build number
and a ref of this repository, it builds the archive on macOS arm64, macOS x64
and Linux x64, then, in the protected `release` environment:

- `scripts/make-channel.ts` puts the archives under release asset names
  (`+bbN` becomes `-bbN`) and writes `channel.json`;
- minisign signs it with the owner's key (secrets `MINISIGN_SECRET_KEY`,
  `MINISIGN_PASSWORD`) and checks the signature with the public key
  (variable `MINISIGN_PUBLIC_KEY`);
- a release `runtime-<version with -bbN>` gets the archives, `channel.json`
  and `channel.json.minisig`.

The plugin reads `RELEASE_CHANNEL_URL` (the latest release's `channel.json`)
and `RELEASE_PUBLIC_KEY` from `src/core/update-source.ts`; the settings can
replace either. Updates stay off while no public key is set; the key is
still `null`.

## Bridge contract tests

`npm run check` includes `tests/bridge-contract.test.ts`, which runs against the
runtime in `.runtime/current.json` (or `GITWAND_RUNTIME_DIR`). Without a built
runtime the suite is skipped with a warning.

- `GITWAND_CONTRACT_NO_PTY=1` skips the terminal and watcher checks. Agent
  sandboxes forbid PTYs and FSEvents, so there they fail without it.
- `GITWAND_KEYCHAIN_TEST=1` adds the Keychain round trip. It writes and then
  deletes the entry `gitwand:test-bb` in the login keychain.
