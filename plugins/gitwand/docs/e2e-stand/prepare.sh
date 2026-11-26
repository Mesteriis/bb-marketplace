#!/bin/sh
# Isolated BB stand for makosh-gitwand: copies the plugin from the worktree,
# npm ci and bb plugin build with the stand HOME. Prints the stand directory.
set -eu
SRC="$1"
BB_APP=/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app
STAND=$(mktemp -d "${TMPDIR:-/tmp}/gitwand-stand.XXXXXX")
mkdir "$STAND/plugin" "$STAND/home" "$STAND/data"
(cd "$SRC" && tar --exclude node_modules --exclude dist --exclude .runtime -cf - .) | tar -x -C "$STAND/plugin"
clean() {
  env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} \
    ${http_proxy:+http_proxy="$http_proxy"} ${https_proxy:+https_proxy="$https_proxy"} \
    ${NO_PROXY:+NO_PROXY="$NO_PROXY"} ${no_proxy:+no_proxy="$no_proxy"} \
    ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} \
    npm_config_cache="$STAND/home/.npm" "$@"
}
cd "$STAND/plugin"
clean npm ci --no-audit --no-fund >&2
clean node "$BB_APP/dist/bb.js" plugin build >&2
echo "$STAND"
