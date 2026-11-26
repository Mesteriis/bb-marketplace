#!/bin/sh
# publish.sh <version> <port> : writes www/channel.json for that build and signs it (minisign, prehashed).
set -eu
cd "$(dirname "$0")"; V="$1"; PORT="$2"; A="gitwand-runtime-$V-darwin-arm64.tar.gz"
SHA=$(shasum -a 256 "www/$A" | cut -d' ' -f1); SIZE=$(stat -f %z "www/$A")
printf '{\n  "version": "%s",\n  "gitwandTag": "v3.14.0",\n  "commit": "436b9684f096e8edd35b6a36e3b4d3af0fd7e084",\n  "minPluginVersion": "0.1.0",\n  "platforms": {\n    "darwin-arm64": { "url": "https://127.0.0.1:%s/%s", "sha256": "%s", "size": %s }\n  }\n}\n' "$V" "$PORT" "$A" "$SHA" "$SIZE" > www/channel.json
TC="timestamp:$(date +%s)	file:channel.json	hashed"
openssl dgst -blake2b512 -binary www/channel.json > key/h.bin
openssl pkeyutl -sign -inkey key/sign.pem -rawin -in key/h.bin -out key/sig.bin
printf '%s' "$TC" > key/tc.txt; cat key/sig.bin key/tc.txt > key/g.in
openssl pkeyutl -sign -inkey key/sign.pem -rawin -in key/g.in -out key/gsig.bin
printf 'untrusted comment: stand\n%s\ntrusted comment: %s\n%s\n' "$(cat key/alg_hashed key/keyid key/sig.bin | base64)" "$TC" "$(base64 < key/gsig.bin)" > www/channel.json.minisig
echo "published $V"
