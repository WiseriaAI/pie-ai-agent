#!/bin/bash
# daemon/install/build-pkg.sh — 编译二进制 + 组 .pkg。用法: build-pkg.sh <EXT_ID> [VERSION]
set -euo pipefail
EXT_ID="${1:?need extension id}"
VERSION="${2:-0.0.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1) 编译单二进制
( cd "$ROOT" && bun build ./src/cli.ts --compile --outfile dist/pie )

# 2) payload 目录
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/usr/local/bin"
cp "$ROOT/dist/pie" "$STAGE/usr/local/bin/pie"
chmod +x "$STAGE/usr/local/bin/pie"

# 3) 注入 EXT_ID 到 host template（postinstall 用到的那份随 scripts 走）
SCRIPTS="$(mktemp -d)"
cp "$ROOT/install/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"
sed "s|__EXT_ID__|$EXT_ID|g" "$ROOT/install/ai.wiseria.pie.host.template.json" > "$SCRIPTS/ai.wiseria.pie.host.template.json"
cp "$ROOT/install/ai.wiseria.pie.plist.template" "$SCRIPTS/"

# 4) 组 pkg（签名/公证：证书就位后加 --sign "Developer ID Installer: ..." + notarytool）
pkgbuild --root "$STAGE" --scripts "$SCRIPTS" \
  --identifier ai.wiseria.pie --version "$VERSION" \
  "$ROOT/dist/pie-$VERSION.pkg"
echo "built dist/pie-$VERSION.pkg (unsigned — sign+notarize before distribution)"
