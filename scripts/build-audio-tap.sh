#!/bin/sh
# Build both backends with a macOS 13 deployment target, then sync the dev helper.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$ROOT/resources/bin/audio-tap.app"
EXECUTABLE="$APP/Contents/MacOS/audio-tap"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for ARCH in x86_64 arm64; do
  xcrun clang -O2 -std=c11 -Wall -Wextra -Werror -target "$ARCH-apple-macos13.0" \
    -c "$ROOT/scripts/audio-support.c" -o "$TMP/audio-support-$ARCH.o"
  xcrun swiftc -O -target "$ARCH-apple-macos13.0" \
    -import-objc-header "$ROOT/scripts/audio-support.h" \
    "$ROOT/scripts/audio-tap.swift" "$ROOT/scripts/chrome-audio.swift" \
    "$TMP/audio-support-$ARCH.o" -o "$TMP/audio-tap-$ARCH"
done
mkdir -p "$APP/Contents/MacOS"
lipo -create "$TMP/audio-tap-x86_64" "$TMP/audio-tap-arm64" -output "$EXECUTABLE"
cp "$ROOT/resources/audio-tap-Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
mkdir -p "$ROOT/out/main/bin"
rm -rf "$ROOT/out/main/bin/audio-tap.app"
ditto "$APP" "$ROOT/out/main/bin/audio-tap.app"
printf 'built and synced %s\n' "$APP"
