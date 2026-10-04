#!/bin/sh
# Only exercises in-memory/native CPU logic. Never opens an audio device or requests permissions.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -c "$ROOT/scripts/audio-support.c" -o "$TMP/audio-support.o"
xcrun swiftc -O -import-objc-header "$ROOT/scripts/audio-support.h" \
  "$ROOT/scripts/chrome-audio.swift" "$ROOT/tests/native-audio.swift" \
  "$TMP/audio-support.o" -o "$TMP/native-audio-tests"
"$TMP/native-audio-tests"
