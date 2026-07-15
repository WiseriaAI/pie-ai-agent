#!/bin/bash
# daemon/menubar/build-app.sh — swiftc 组 Pie Link.app。用法: build-app.sh [OUT_DIR] [VERSION]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../dist}"
VERSION="${2:-0.0.0}"
APP="$OUT/Pie Link.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# arm64 + x86_64 双 target 一次出 universal
swiftc -O -target arm64-apple-macos13 -o "$OUT/pielink-arm64" "$HERE/main.swift" -framework AppKit
swiftc -O -target x86_64-apple-macos13 -o "$OUT/pielink-x64" "$HERE/main.swift" -framework AppKit
lipo -create "$OUT/pielink-arm64" "$OUT/pielink-x64" -output "$APP/Contents/MacOS/Pie Link"
rm "$OUT/pielink-arm64" "$OUT/pielink-x64"
# app 图标：预生成的 .icns 直接入库并拷进 Resources（CI runner 无 SVG 光栅化工具链，
# 不在构建期从 SVG 生成）。CFBundleIconFile=PieLink 对应此文件名。
cp "$HERE/PieLink.icns" "$APP/Contents/Resources/PieLink.icns"
sed "s|__VERSION__|$VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
echo "built $APP"
