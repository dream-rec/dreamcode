#!/bin/sh
# Builds the universal macOS per-app audio capture helper into resources/bin/audio-tap.
set -e
cd "$(dirname "$0")/.."
OUT=resources/bin/audio-tap
TMP=$(mktemp -d)
for ARCH in x86_64 arm64; do
  swiftc -O -target "$ARCH-apple-macos13.0" scripts/audio-tap.swift -o "$TMP/audio-tap-$ARCH"
done
lipo -create "$TMP/audio-tap-x86_64" "$TMP/audio-tap-arm64" -output "$OUT"
rm -rf "$TMP"
codesign --force --sign - "$OUT"
echo "built $OUT"
