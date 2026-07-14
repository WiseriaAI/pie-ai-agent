#!/bin/bash
# daemon/install/build-pkg.sh — 组 .pkg。用法: build-pkg.sh <EXT_ID> [VERSION] [BIN] [APP]
# BIN 缺省 = 本机编译 dist/pie（开发路径，unsigned）；给定 = 使用外部（已签名）二进制。
# APP 给定 = 把顶栏 app（Pie Link.app）放进 payload /Applications/（signed .app 在 release-pkg.sh 层准备）。
# 产物 pkg 本身不签名——签名/公证在 release-pkg.sh（CI）层做。
set -euo pipefail
EXT_ID="${1:?need extension id}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${2:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")}"
BIN="${3:-}"
APP="${4:-}"

if [ -z "$BIN" ]; then
  ( cd "$ROOT" && bun build ./src/cli.ts --compile --outfile dist/pie )
  BIN="$ROOT/dist/pie"
fi

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/usr/local/bin"
cp "$BIN" "$STAGE/usr/local/bin/pie"
chmod +x "$STAGE/usr/local/bin/pie"

if [ -n "$APP" ]; then
  mkdir -p "$STAGE/Applications"
  cp -R "$APP" "$STAGE/Applications/"
fi

SCRIPTS="$(mktemp -d)"
cp "$ROOT/install/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"
sed "s|__EXT_ID__|$EXT_ID|g" "$ROOT/install/ai.wiseria.pie.host.template.json" > "$SCRIPTS/ai.wiseria.pie.host.template.json"
cp "$ROOT/install/ai.wiseria.pie.plist.template" "$SCRIPTS/"
cp "$ROOT/install/ai.wiseria.pie.menubar.plist.template" "$SCRIPTS/"

mkdir -p "$ROOT/dist"
pkgbuild --root "$STAGE" --scripts "$SCRIPTS" \
  --identifier ai.wiseria.pie --version "$VERSION" \
  "$ROOT/dist/pie-link-$VERSION.pkg"
echo "built dist/pie-link-$VERSION.pkg (unsigned)"
