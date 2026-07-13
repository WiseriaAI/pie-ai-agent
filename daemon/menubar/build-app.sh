#!/bin/bash
# daemon/menubar/build-app.sh — swiftc 组 Pie Link.app。用法: build-app.sh [OUT_DIR] [VERSION]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../dist}"
VERSION="${2:-0.0.0}"
APP="$OUT/Pie Link.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
# arm64 + x86_64 双 target 一次出 universal
swiftc -O -target arm64-apple-macos13 -o "$OUT/pielink-arm64" "$HERE/main.swift" -framework AppKit
swiftc -O -target x86_64-apple-macos13 -o "$OUT/pielink-x64" "$HERE/main.swift" -framework AppKit
lipo -create "$OUT/pielink-arm64" "$OUT/pielink-x64" -output "$APP/Contents/MacOS/Pie Link"
rm "$OUT/pielink-arm64" "$OUT/pielink-x64"
sed "s|__VERSION__|$VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
echo "built $APP"
