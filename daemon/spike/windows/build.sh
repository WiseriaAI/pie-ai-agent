#!/bin/bash
# Gate 0 spike 包构建（在 mac 上交叉编译 windows-x64）。产物：dist/pie-spike-win-x64.zip
set -euo pipefail
cd "$(dirname "$0")/../.."   # daemon/

OUT=spike/windows/dist
rm -rf "$OUT"
mkdir -p "$OUT/pie-spike"

bun build spike/windows/spike.ts --compile --target=bun-windows-x64 --outfile "$OUT/pie-spike/pie-spike.exe"
cp node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe "$OUT/pie-spike/"
cp spike/windows/README.md "$OUT/pie-spike/"

(cd "$OUT" && zip -rq pie-spike-win-x64.zip pie-spike)
echo "built: daemon/$OUT/pie-spike-win-x64.zip"
ls -lh "$OUT/pie-spike-win-x64.zip"
