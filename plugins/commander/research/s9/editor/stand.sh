#!/bin/bash
set -eu
stand="$1"
app="$2"
ports=$(node -e 'const net=require("node:net"); const listen=()=>new Promise(r=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>r(s))}); Promise.all([listen(),listen()]).then(ss=>{console.log(ss.map(s=>s.address().port).join(" "));ss.forEach(s=>s.close())})')
server_port=${ports% *}
daemon_port=${ports#* }
url="http://127.0.0.1:$server_port"
cli() {
  env -i HOME="$stand/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" BB_TELEMETRY=false BB_DATA_DIR="$stand/data" BB_SERVER_URL="$url" BB_HOST_DAEMON_PORT="$daemon_port" node "$app/dist/bb.js" "$@"
}
env -i HOME="$stand/home" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" BB_TELEMETRY=false BB_SKIP_ONBOARDING=true NODE_ENV=production \
  node "$app/dist/bb-app.js" --data-dir "$stand/data" --server-port "$server_port" --host-daemon-port "$daemon_port" \
  --bundled --no-in-app-updates > "$stand/bb.log" 2>&1 &
launcher=$!
trap 'kill -TERM "$launcher" 2>/dev/null || true; wait "$launcher" 2>/dev/null || true' EXIT
i=0
until curl -fsS --max-time 2 "$url/health" >/dev/null 2>&1; do
  kill -0 "$launcher" 2>/dev/null || { echo 'BB launcher exited before health'; exit 1; }
  i=$((i+1))
  [ "$i" -le 80 ] || { echo 'BB health timeout'; exit 1; }
  sleep .25
done
echo 'PASS health'
cli plugin install "$stand/plugin" --yes > "$stand/install.log" 2>&1 || { echo 'Plugin install failed'; exit 1; }
printf '%s\n' "$url" > "$stand/url"
i=0
while [ ! -f "$stand/done" ] && [ "$i" -lt 300 ]; do
  sleep 1
  i=$((i+1))
done
