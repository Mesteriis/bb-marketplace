# Vendored noVNC (unmodified)

Remote Hub draws the graphical console of a Proxmox QEMU guest with noVNC. The files here are an **unmodified** copy of the
upstream ES-module sources, so the same files are bundled into the plugin and run in its tests.

| | |
|---|---|
| Upstream | https://github.com/novnc/noVNC |
| Tag | `v1.6.0` |
| Commit | `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820` (`git ls-remote` shows it as `refs/tags/v1.6.0^{}`) |
| Taken | `core/` (the noVNC core library) and `vendor/pako/` (zlib port used by `core/inflator.js` and `core/deflator.js`), plus `LICENSE.txt`, `AUTHORS` and `docs/LICENSE.MPL-2.0` |
| Not taken | `app/`, `utils/`, `tests/`, `po/`, `docs/` (other than the licence), `snap/`, images, html, the CommonJS build (`lib/`) |
| Changes | none; `MANIFEST.sha256` lists the SHA-256 of every file |
| Licence | MPL-2.0 (core), MIT (`vendor/pako`), `core/crypto/des.js` carries its own BSD-style notice; every per-file header is intact. See `LICENSE.txt` |

## Why vendored, not the npm package

`@novnc/novnc@1.6.0` on npm ships only the Babel CommonJS build (`lib/`), and its `lib/util/browser.js` has a module-level
`await`, which neither Node (tests) nor the plugin bundler can load as CommonJS. The `core/` tree of the git tag is plain ES
modules; there is one copy only, and `package.json` has no noVNC entry.

## How the plugin finds it

The import `@novnc/novnc/core/*` is mapped to `vendor/novnc/core/*` by `tsconfig.json` (`paths`, which `bb plugin build` reads)
and by the alias in `vitest.config.ts`. `npm run check:vendor` recomputes the checksums and fails if a file differs, is missing
or is extra.

## Updating

Replace the directories from a newer tag, regenerate the manifest with `node scripts/check-vendor.mjs --write`, update this
file and `THIRD_PARTY_NOTICES.md`, and run the console tests (`src/ui/vnc-view.test.tsx`).
