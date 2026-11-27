# Isolated BB stand

Browser acceptance runs on a throwaway BB instance with its own `HOME`, data directory and ports, never on the
maintainer's BB. Same approach as GitWand's stand (`gitwand/v0.2.0`) and `plugins/chertog/docs/e2e-stand.md`.

Needs `git`, `node`, `npm`, `curl`, access to `registry.npmjs.org`, BB at
`/Applications/dev/bb.app` (or `BB_APP=<bb-app package>`) and `chrome-headless-shell` in
`~/Library/Caches/ms-playwright` (or `CHROME=<path>`). Chromium does not start inside agent sandboxes: run
`run.sh` outside them.

```sh
S=$(docs/e2e-stand/prepare.sh "$PWD") && docs/e2e-stand/run.sh "$S" "$PWD/docs/e2e-stand/smoke.mjs"
```

- `prepare.sh` copies this package into a new `$TMPDIR/git-dashboard-stand.*`, runs `npm ci` and
  `bb plugin build` with the stand `HOME`, and installs `playwright-core` into `$S/tools`.
- `run.sh` starts the instance, installs the plugin, creates the project `stand-alpha` on a repository whose
  origin is `git@github.com:stand-owner/alpha.git`, runs each probe, stops the instance and checks that the
  server no longer answers. It exits 0 only with `STAND PASS`; each probe passes only if its last line is
  `PASS`. Logs and screenshots are in `$S/out`.
- `smoke.mjs` — the Git panel attaches the copy and the repository panel shows the forge detected from the SSH
  origin, with no account connected; no horizontal overflow at 768 px; no page errors.

The stand has no provider accounts, so no request leaves the machine.
