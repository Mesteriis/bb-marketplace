#!/bin/sh
# Starts an isolated BB (own HOME, data directory and ports), installs the prepared plugin, creates a
# project on a repository, runs every probe given after the stand directory, stops the instance.
# Exit code 0 only when the plugin runs and every probe prints "PASS" as its last line.
# Usage: run.sh <stand> <probe.mjs> [<probe.mjs> ...]
set -eu
STAND="$1"; shift
[ -d "$STAND/plugin/dist" ] || { echo "not a prepared stand: $STAND"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
BB_APP=${BB_APP:-/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app}
CHROME=${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell 2>/dev/null | tail -1)}
PORTS=$(node -e 'const n=require("node:net");const f=()=>new Promise(r=>{const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})});(async()=>console.log(await f(),await f(),await f()))()')
SERVER_PORT=$(echo "$PORTS" | cut -d' ' -f1); DAEMON_PORT=$(echo "$PORTS" | cut -d' ' -f2); FORGE_PORT=$(echo "$PORTS" | cut -d' ' -f3)
URL="http://127.0.0.1:$SERVER_PORT"
cli() { env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" NODE_EXTRA_CA_CERTS="$STAND/forge/cert.pem" BB_TELEMETRY=false BB_DATA_DIR="$STAND/data" BB_SERVER_URL="$URL" BB_HOST_DAEMON_PORT="$DAEMON_PORT" node "$BB_APP/dist/bb.js" "$@"; }

# A repository with a GitHub SSH origin; the stand has no accounts, so no request leaves the machine.
R="$STAND/home/projects/alpha"; rm -rf "$R"; mkdir -p "$R"
git -C "$R" init -q -b main
echo a > "$R/changed.txt"; git -C "$R" add .; git -C "$R" -c user.email=stand@example.invalid -c user.name=stand commit -qm "first commit"
git -C "$R" remote add origin git@github.com:stand-owner/alpha.git
# A small graph for the History tab: a feature branch merged back, a tag on the merge, a side branch.
c() { git -C "$R" -c user.email=stand@example.invalid -c user.name=stand "$@"; }
c switch -q -c feature; echo 2 > "$R/feature.txt"; c add .; c commit -qm "feature work"
c switch -q main; echo main >> "$R/changed.txt"; c commit -qam "main work"
c merge -q --no-ff feature -m "merge feature"; c tag -a v1.0 -m "release 1.0"
c switch -q -c side HEAD~1; echo s > "$R/side.txt"; c add .; c commit -qm "side tip"; c switch -q main
echo b >> "$R/changed.txt"

# A stand-in Gitea over HTTPS with its own certificate, and a repository whose origin is on it.
mkdir -p "$STAND/forge"; : > "$STAND/forge/writes.log"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$STAND/forge/key.pem" -out "$STAND/forge/cert.pem" 2>/dev/null
node "$HERE/fake-forge.mjs" "$STAND/forge/cert.pem" "$STAND/forge/key.pem" "$FORGE_PORT" "$STAND/forge/writes.log" > "$STAND/forge/forge.log" 2>&1 &
FORGE=$!
B="$STAND/home/projects/beta"; rm -rf "$B"; mkdir -p "$B"
git -C "$B" init -q -b main
echo a > "$B/README.md"; git -C "$B" add .; git -C "$B" -c user.email=stand@example.invalid -c user.name=stand commit -qm "first commit"
git -C "$B" remote add origin "https://localhost:$FORGE_PORT/stand/beta.git"

env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_EXTRA_CA_CERTS="$STAND/forge/cert.pem" \
  BB_TELEMETRY=false BB_SKIP_ONBOARDING=true NODE_ENV=production \
  node "$BB_APP/dist/bb-app.js" --data-dir "$STAND/data" \
  --server-port "$SERVER_PORT" --host-daemon-port "$DAEMON_PORT" \
  --bundled --no-in-app-updates > "$STAND/bb-app.log" 2>&1 &
LAUNCHER=$!
stop() {
  kill -TERM "$FORGE" 2>/dev/null || true
  kill -TERM "$LAUNCHER" 2>/dev/null || true
  i=0; while kill -0 "$LAUNCHER" 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
  if kill -0 "$LAUNCHER" 2>/dev/null; then kill -KILL "$LAUNCHER"; fi
}
trap stop EXIT
i=0; until curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; do
  kill -0 "$LAUNCHER" 2>/dev/null || { echo "bb-app exited early"; tail -30 "$STAND/bb-app.log"; exit 1; }
  i=$((i+1)); [ $i -gt 240 ] && { echo "health timeout"; exit 1; }
  sleep 0.5
done
echo "== server $URL"
cli plugin install "$STAND/plugin" --yes >/dev/null
cli plugin list --json > "$STAND/plugin-list.json"
node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins??[];const p=l.find(x=>x.id==="bb-git-dashboard");console.log(JSON.stringify({id:p?.id,version:p?.version,status:p?.status,error:p?.error}));process.exit(p?.status==="running"?0:1)' "$STAND/plugin-list.json"
cli plugin config bb-git-dashboard set accounts "[{\"kind\":\"gitea\",\"id\":\"stand-gitea\",\"label\":\"stand\",\"origin\":\"https://localhost:$FORGE_PORT\",\"organization\":\"\",\"username\":\"stand\"}]" >/dev/null
cli plugin config bb-git-dashboard set tokens '{"stand-gitea":"stand-token"}' >/dev/null
id_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
PROJECT=$(cli project create --name stand-alpha --root "$R" --json | id_of)
BETA=$(cli project create --name stand-beta --root "$B" --json | id_of)
printf 'URL=%s/\nPROJECT=%s\nREPO=%s\nBETA=%s\nFORGE=https://localhost:%s\n' "$URL" "$PROJECT" "$R" "$BETA" "$FORGE_PORT" > "$STAND/facts.env"
cat "$STAND/facts.env"
mkdir -p "$STAND/out"
status=0
for probe in "$@"; do
  echo "== probe $probe"
  last=$(env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" NODE_PATH="$STAND/tools/node_modules" STAND="$STAND" \
    node "$probe" "$URL/" "$STAND/tools" "$CHROME" "$STAND/out" "$PROJECT" "$R" 2>&1 | tee "$STAND/out/$(basename "$probe").log" | tail -1)
  echo "$last"
  [ "$last" = "PASS" ] || status=1
done
stop; trap - EXIT
if curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; then echo "server still answers after stop"; exit 1; fi
[ $status -eq 0 ] && echo "STAND PASS" || echo "STAND FAIL"
exit $status
