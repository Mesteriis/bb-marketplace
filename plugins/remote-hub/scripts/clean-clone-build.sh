#!/usr/bin/env bash
# Builds Remote Hub from a CLEAN CLONE of a committed ref and runs every gate there (stage 5, item 6).
#   scripts/clean-clone-build.sh [ref]      default: HEAD of the repository this script lives in
# Nothing is pushed or installed; the clone lives in a temporary directory that is removed at the end unless KEEP=1.
# Steps: git clone (local, committed files only) -> npm ci -> npm run check -> npm run build -> cargo release build (--locked)
# -> helper:sums into a scratch copy -> check:dist, check:release, check:notices, check-manifests -> hashes.
set -euo pipefail
here="$(cd "$(dirname "$0")/../../.." && pwd)"
ref="${1:-HEAD}"
work="$(mktemp -d "${TMPDIR:-/tmp}/rh-clean.XXXXXX")"
cleanup() { [ "${KEEP:-0}" = "1" ] && echo "kept: $work" || rm -rf "$work"; }
trap cleanup EXIT
sha="$(git -C "$here" rev-parse "$ref")"
git clone --quiet --no-checkout "$here" "$work/repo"
git -C "$work/repo" checkout --quiet "$sha"
echo "== clean clone of $sha (uncommitted files in the working tree are NOT included)"
cd "$work/repo/plugins/remote-hub"
# A release commit carries bin/ and dist/: they are checked as committed, then rebuilt and compared.
committed=0
if [ -e bin/remote-hub-helper ] || [ -e dist/app.js ]; then
  committed=1
  echo "== release commit: gates on the COMMITTED bin/ and dist/"
  npm ci --no-audit --no-fund >/dev/null
  npm run check:dist
  npm run check:release
  mkdir "$work/committed" && cp -R bin dist "$work/committed/"
  rm -rf bin dist
fi
echo "== npm ci";            npm ci --no-audit --no-fund >/dev/null
echo "== npm run check";     npm run check 2>&1 | grep -E "error|Test Files|Tests " || true
npm run check >/dev/null
echo "== npm run build";     npm run build >/dev/null
echo "== helper (release, --locked)"
npm run build:helper 2>&1 | tail -1
echo "== helper checksum (scratch copy of the release step)"
npm run helper:sums
echo "== gates"
npm run check:dist
npm run check:release
npm run check:notices
(cd ../.. && node scripts/check-manifests.mjs)
if [ "$committed" = 1 ]; then
  echo "== committed vs rebuilt"
  for f in bin/remote-hub-helper dist/app.js dist/app.css dist/server.js dist/app.meta.json dist/server.meta.json; do
    a="$(shasum -a 256 "$work/committed/$f" | cut -d' ' -f1)"; b="$(shasum -a 256 "$f" | cut -d' ' -f1)"
    [ "$a" = "$b" ] && echo "identical  $f" || echo "DIFFERENT  $f  committed=$a rebuilt=$b"
  done
fi
echo "== artefacts"
shasum -a 256 bin/remote-hub-helper dist/app.js dist/app.css dist/server.js
echo "== helper --version: $(bin/remote-hub-helper --version)"
echo "clean-clone build ok for $sha"
