#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
clang -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations \
  -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -framework Security -framework CoreFoundation native/vault-key.c -o bin/vault-key
codesign --force --sign - --identifier app.getbb.makosh.credential-vault.key \
  --options runtime bin/vault-key
codesign --verify --all-architectures --strict bin/vault-key
