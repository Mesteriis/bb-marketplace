#!/bin/sh
# Resets the stand repository (same path, so the thread's environment stays valid).
set -eu
STAND="$1"; R="$STAND/repo"
rm -rf "$R/.git" "$STAND/remote.git" "$STAND/other"
find "$R" -mindepth 1 -delete
git init -q -b main "$R"
git -C "$R" config user.email stand@example.invalid; git -C "$R" config user.name stand
echo a > "$R/changed.txt"; git -C "$R" add .; git -C "$R" commit -qm "first commit"
echo b >> "$R/changed.txt"
