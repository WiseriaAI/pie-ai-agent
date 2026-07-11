#!/bin/bash
# daemon/install/release-pkg.sh — 签名发布全链。CI（或有证书的本机）调用。
# 前提: keychain 已导入 Developer ID Application + Installer 证书；
# env: APPLE_NOTARY_KEY / APPLE_NOTARY_KEY_ID / APPLE_NOTARY_KEY_ISSUER
set -euo pipefail
EXT_ID="${1:?need extension id}"
VERSION="${2:?need version}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${APPLE_NOTARY_KEY:?}" "${APPLE_NOTARY_KEY_ID:?}" "${APPLE_NOTARY_KEY_ISSUER:?}"

APP_ID="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
INST_ID="$(security find-identity -v | sed -n 's/.*"\(Developer ID Installer: [^"]*\)".*/\1/p' | head -1)"
[ -n "$APP_ID" ] || { echo "no Developer ID Application identity in keychain" >&2; exit 1; }
[ -n "$INST_ID" ] || { echo "no Developer ID Installer identity in keychain" >&2; exit 1; }

# 1) 双 target 编译 + lipo universal
( cd "$ROOT" \
  && bun build ./src/cli.ts --compile --target=bun-darwin-arm64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" --outfile dist/pie-arm64 \
  && bun build ./src/cli.ts --compile --target=bun-darwin-x64 \
       --define "process.env.PIE_DAEMON_VERSION=\"$VERSION\"" --outfile dist/pie-x64 )
lipo -create "$ROOT/dist/pie-arm64" "$ROOT/dist/pie-x64" -output "$ROOT/dist/pie-universal"

# 2) 签二进制（hardened runtime + JIT entitlements）
codesign --force --options runtime --timestamp \
  --entitlements "$ROOT/install/pie.entitlements" \
  --sign "$APP_ID" "$ROOT/dist/pie-universal"
codesign --verify --strict "$ROOT/dist/pie-universal"

# 3) 组 pkg（unsigned）→ productsign
"$ROOT/install/build-pkg.sh" "$EXT_ID" "$VERSION" "$ROOT/dist/pie-universal"
mv "$ROOT/dist/pie-link-$VERSION.pkg" "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"
productsign --sign "$INST_ID" \
  "$ROOT/dist/pie-link-$VERSION-unsigned.pkg" "$ROOT/dist/pie-link-$VERSION.pkg"
rm "$ROOT/dist/pie-link-$VERSION-unsigned.pkg"

# 4) 公证 + staple
KEY_FILE="$(mktemp)"; printf '%s' "$APPLE_NOTARY_KEY" > "$KEY_FILE"
xcrun notarytool submit "$ROOT/dist/pie-link-$VERSION.pkg" \
  --key "$KEY_FILE" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_KEY_ISSUER" \
  --wait
rm "$KEY_FILE"
xcrun stapler staple "$ROOT/dist/pie-link-$VERSION.pkg"
echo "signed+notarized dist/pie-link-$VERSION.pkg"
