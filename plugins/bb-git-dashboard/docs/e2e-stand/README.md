# Isolated BB stand

Browser acceptance runs on a throwaway BB instance with its own `HOME`, data directory and ports, never on the
maintainer's BB. Same approach as GitWand's stand (`gitwand/v0.2.0`) and `plugins/chertog/docs/e2e-stand.md`.

Needs `git`, `node`, `npm`, `curl`, access to `registry.npmjs.org`, BB at
`/Applications/dev/bb.app` (or `BB_APP=<bb-app package>`) and `chrome-headless-shell` in
`~/Library/Caches/ms-playwright` (or `CHROME=<path>`). Chromium does not start inside agent sandboxes: run
`run.sh` outside them.

```sh
S=$(docs/e2e-stand/prepare.sh "$PWD") && docs/e2e-stand/run.sh "$S" "$PWD/docs/e2e-stand/smoke.mjs" "$PWD/docs/e2e-stand/ci.mjs" "$PWD/docs/e2e-stand/code-review.mjs" "$PWD/docs/e2e-stand/history.mjs" "$PWD/docs/e2e-stand/gitlab.mjs" "$PWD/docs/e2e-stand/inbox.mjs" "$PWD/docs/e2e-stand/review.mjs"
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

- `inbox.mjs` — My PRs over the Gitea and GitLab stand-ins: tab counts over both accounts, blockers and their stripe, a
  stack, search, j/k, hiding a repository, Review requested and Merged; then the watcher (2-minute round on the
  stand) alerts when a merge request's pipeline starts failing: toast, New since you last looked, the count on
  **Мои PR**, Mark as seen. It waits up to four minutes for the alert.

- `review.mjs` — pull request and issue pages: a Gitea pull request opened from My PRs with its conflict, review,
  discussion and failing check, its review thread under its line, a line comment and a comment; a GitLab merge
  request's thread resolved, an approval of another author's merge request pinned to the head, no request-changes
  review, a draft made ready; a GitLab issue's comment and a new issue — each through the confirmation dialog and once
  in the stand-ins' write logs.

- `history.mjs` — the History tab of `stand-alpha`: commit count over all branches, the merge with its branch and
  tag labels, more than one lane, the uncommitted change on top with its patch, a commit's files and patch,
  spacing and layout at 768 px.

No request leaves the machine.
