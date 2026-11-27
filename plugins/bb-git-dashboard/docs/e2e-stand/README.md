# Isolated BB stand

Browser acceptance runs on a throwaway BB instance with its own `HOME`, data directory and ports, never on the
maintainer's BB. Same approach as GitWand's stand (`gitwand/v0.2.0`) and `plugins/chertog/docs/e2e-stand.md`.

Needs `git`, `node`, `npm`, `curl`, access to `registry.npmjs.org`, BB at
`/Applications/dev/bb.app` (or `BB_APP=<bb-app package>`) and `chrome-headless-shell` in
`~/Library/Caches/ms-playwright` (or `CHROME=<path>`). Chromium does not start inside agent sandboxes: run
`run.sh` outside them.

```sh
S=$(docs/e2e-stand/prepare.sh "$PWD") && docs/e2e-stand/run.sh "$S" "$PWD/docs/e2e-stand/smoke.mjs" "$PWD/docs/e2e-stand/ci.mjs" "$PWD/docs/e2e-stand/history.mjs" "$PWD/docs/e2e-stand/gitlab.mjs"
```

- `prepare.sh` copies this package into a new `$TMPDIR/git-dashboard-stand.*`, runs `npm ci` and
  `bb plugin build` with the stand `HOME`, and installs `playwright-core` into `$S/tools`.
- A prepared stand serves one run: `run.sh` picks new ports, and tokens saved by an earlier run stay bound to
  the old servers, so it refuses a used stand.
- `run.sh` starts `fake-forge.mjs` — an HTTPS stand-in for a Gitea server with its own throwaway certificate,
  trusted by the instance through `NODE_EXTRA_CA_CERTS` — then the instance; installs the plugin; configures a
  Gitea account for the stand-in; creates the project `stand-alpha` (origin `git@github.com:stand-owner/alpha.git`)
  with a small graph — a merged feature branch, an annotated tag, a side branch and an uncommitted edit — and
  `stand-beta` (origin on the stand-in); runs each probe, stops the instance and checks that the
  server no longer answers. It exits 0 only with `STAND PASS`; each probe passes only if its last line is
  `PASS`. Logs and screenshots are in `$S/out`.
- `smoke.mjs` — the Git panel attaches the copy and the repository panel shows the forge detected from the SSH
  origin, with no account connected; no horizontal overflow at 768 px; no page errors.
- `ci.mjs` — `stand-beta` connects to the stand-in automatically; runs and the Failed filter; the failed job's
  log opens at its error line, scrolling only the log; re-run failed jobs and a manual run with inputs go through
  the confirmation dialog and reach the stand-in exactly once (`$S/forge/writes.log`); Ask agent opens a thread;
  layout at 768 px.

- `gitlab.mjs` — `stand-gamma` has its origin on `fake-gitlab.mjs`, a self-managed GitLab stand-in on the same
  host name as the Gitea one, told apart by port: automatic connection; pipelines with the Active and Failed
  filters; jobs named by stage; the trace opens at the job's own `ERROR:` line, not the runner's closing one, with
  section markers and colours removed; retry and Run pipeline with a variable go through the confirmation dialog
  and reach the stand-in once (`$S/forge/gitlab-writes.log`); issues; variables listed without values.

- `history.mjs` — the History tab of `stand-alpha`: commit count over all branches, the merge with its branch and
  tag labels, more than one lane, the uncommitted change on top with its patch, a commit's files and patch,
  spacing and layout at 768 px.

No request leaves the machine.
