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
5. Full acceptance (plan section «Проверка»), on the same stand:
   `docs/e2e-stand/reset-repo.sh "$S"; node docs/e2e-stand/acceptance.mjs "$URL/" <tools> <chrome> <out> "$PROJECT" "$THREAD" "$REPO" "$S"`
   — one line per check: tab, narrow tab 480/560 px, stage/commit, watcher,
   diff/history/branches, merge conflict in GitWand's editor, push/fetch/pull
   on a local bare repository, terminal (`git --version`, resize).
6. Update acceptance: a stand without a development runtime
   (`STAND_CA=<tls.crt> run.sh "$S" -`), a local https channel
   (`channel/serve.mjs`, `channel/publish.sh <version> <port>` signs
   `channel.json` with a throwaway minisign key made by OpenSSL; see the
   script for the key files it expects), settings `updateChannelUrl` and
   `updatePublicKey` set with `bb plugin config`, then
   `node docs/e2e-stand/update.mjs …`: first install from the channel, the next
   build through GitWand's own update banner, rollback, a tampered manifest.
7. `touch "$S/stop"` — the instance stops; `run.sh` checks the server no
   longer answers and no `gitwand-bridge` of the stand is left.

Clean install from the marketplace, before a release reaches the owner's BB:
`S=$(mktemp -d); run-market.sh "$S" <checkout with the catalog entry>` adds
that checkout as a `path:` marketplace and installs `makosh-gitwand@mesteriis`,
which builds from the entry's git source (`main` on GitHub) without
devDependencies, as a real install does. Then
`. "$S/facts.env"; node docs/e2e-stand/market.mjs "$URL/" <tools> <chrome> <out> "$PROJECT" "$THREAD"`
installs the runtime from the real signed channel through the settings
section and opens the tab; it exits 0 only if all of that worked.

Chromium, PTYs and FSEvents do not work inside agent sandboxes: run steps 3–5
outside them. Do not edit `run.sh` while an instance runs it.
