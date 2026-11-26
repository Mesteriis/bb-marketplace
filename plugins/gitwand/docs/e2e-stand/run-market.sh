#!/bin/sh
# Start an isolated BB with no development runtime, add a path: marketplace
# (the catalog directory, $2) and install makosh-gitwand@mesteriis from it, create
# a repository, a project and a thread, then hold until $STAND/stop.
set -eu
STAND="$1"; RUNTIME=-
CATALOG="$2"; mkdir -p "$STAND/home" "$STAND/data"
BB_APP=/Applications/dev/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app
PORTS=$(node -e 'const n=require("node:net");const f=()=>new Promise(r=>{const s=n.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})});(async()=>console.log(await f(),await f()))()')
SERVER_PORT=${PORTS% *}; DAEMON_PORT=${PORTS#* }
URL="http://127.0.0.1:$SERVER_PORT"
cli() { env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" BB_TELEMETRY=false BB_DATA_DIR="$STAND/data" BB_SERVER_URL="$URL" BB_HOST_DAEMON_PORT="$DAEMON_PORT" node "$BB_APP/dist/bb.js" "$@"; }
# RUNTIME "-" runs without a development runtime (the update channel installs one).
# STAND_CA adds a CA the stand trusts (a local https update channel).
env -i HOME="$STAND/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  ${RUNTIME:+$( [ "$RUNTIME" = "-" ] || echo GITWAND_RUNTIME_DIR="$RUNTIME" )} \
  ${STAND_CA:+NODE_EXTRA_CA_CERTS="$STAND_CA"} \
  BB_TELEMETRY=false BB_SKIP_ONBOARDING=true NODE_ENV=production \
  node "$BB_APP/dist/bb-app.js" --data-dir "$STAND/data" \
  --server-port "$SERVER_PORT" --host-daemon-port "$DAEMON_PORT" \
  --bundled --no-in-app-updates > "$STAND/bb-app.log" 2>&1 &
LAUNCHER=$!
stop() {
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
echo "== server $URL (launcher $LAUNCHER)"
cli marketplace add "path:$CATALOG" --json > "$STAND/marketplace-add.json"; cli plugin install makosh-gitwand@mesteriis --yes; cli plugin source makosh-gitwand --json > "$STAND/plugin-source.json"
cli plugin list --json > "$STAND/plugin-list.json"
node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins??[];const p=l.find(x=>x.id==="makosh-gitwand");console.log(JSON.stringify({id:p?.id,status:p?.status,compatible:p?.app?.bundle?.compatible,error:p?.error}));process.exit(p?.status==="running"?0:1)' "$STAND/plugin-list.json"
R="$STAND/repo"; rm -rf "$R"; git init -q -b main "$R"
echo a > "$R/changed.txt"; git -C "$R" add .; git -C "$R" -c user.email=stand@example.invalid -c user.name=stand commit -qm "first commit"
git -C "$R" config user.email stand@example.invalid; git -C "$R" config user.name stand
echo b >> "$R/changed.txt"
PROJECT=$(cli project create --name gitwand-stand --root "$R" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
# The environment appears on the first send; the stand HOME has no provider credentials, so the turn fails.
THREAD=$(cli thread spawn --project "$PROJECT" --environment "$R" --prompt "Reply OK" --title "GitWand stand" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.id){console.error(s);process.exit(1)}console.log(j.id)})')
i=0; until cli thread show "$THREAD" --json | grep -q '"environmentId": "env_'; do i=$((i+1)); [ $i -gt 60 ] && { echo "thread got no environment"; exit 1; }; sleep 1; done
printf 'URL=%s\nPROJECT=%s\nTHREAD=%s\nREPO=%s\nLAUNCHER=%s\nDAEMON_PORT=%s\n' "$URL" "$PROJECT" "$THREAD" "$R" "$LAUNCHER" "$DAEMON_PORT" > "$STAND/facts.env"
cat "$STAND/facts.env"
echo "== holding; touch $STAND/stop to finish"
while [ ! -e "$STAND/stop" ]; do sleep 1; done
stop; trap - EXIT
echo "== after stop"
if curl -fsS --max-time 2 "$URL/health" >/dev/null 2>&1; then echo "server still answers"; exit 1; fi
sleep 1
if pgrep -fl "$STAND/.*gitwand-bridge|${RUNTIME#-}/bin/gitwand-bridge" | grep -v pgrep; then echo "gitwand-bridge survived the stand"; exit 1; fi
echo "STAND STOPPED CLEAN"
