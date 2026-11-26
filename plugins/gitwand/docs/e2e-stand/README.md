# Isolated BB stand: live scenario

The live acceptance of the plugin runs on a second, throwaway BB instance
(server, host daemon and web UI on their own ports, own data directory and
HOME), never on the maintainer's BB. Same approach as
`plugins/chertog/docs/e2e-stand.md`.

1. Build a runtime: `node scripts/build-runtime.ts …` (see the package README).
2. `S=$(docs/e2e-stand/prepare.sh "$PWD")` — copies this package into a new
   `$TMPDIR/gitwand-stand.*`, `npm ci`, `bb plugin build` with the stand HOME.
3. `docs/e2e-stand/run.sh "$S" "$PWD/.runtime/<version>-<platform>" &` —
   starts the instance with `GITWAND_RUNTIME_DIR`, installs the plugin,
   creates a repository with one modified file, a project and a thread on it
   (the first send fails without provider credentials, which is expected:
   it only gives the thread its environment), writes `$S/facts.env` and holds.
4. `. "$S/facts.env"; node docs/e2e-stand/scenario.mjs "$URL/" <dir with playwright-core> <chrome-headless-shell> <out dir> "$PROJECT" "$THREAD" "$REPO"`
   — opens the thread, the GitWand header action, checks the iframe URL and
   desktop mode, stages and commits (checked with `git log` on disk), runs a
   command in GitWand's terminal (checked through the file it writes), opens
   the sidebar page and the settings section. Exit code 0 only on
   `SCENARIO PASS`.
5. `touch "$S/stop"` — the instance stops; `run.sh` checks the server no
   longer answers and no `gitwand-bridge` of the stand is left.

Chromium, PTYs and FSEvents do not work inside agent sandboxes: run steps 3–5
outside them. Do not edit `run.sh` while an instance runs it.
