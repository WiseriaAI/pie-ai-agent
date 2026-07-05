#!/bin/bash
# daemon/install/postinstall.sh — .pkg 装完后由 Installer 以用户上下文运行
set -euo pipefail

PIE_BIN="/usr/local/bin/pie"
HOST_WRAPPER="/usr/local/bin/pie-host"
PIE_DIR="$HOME/.pie"
NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LA_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$PIE_DIR/logs" "$NM_DIR" "$LA_DIR"

# host wrapper（Chrome spawn 它 → 转 `pie host`）
printf '#!/bin/bash\nexec %s host "$@"\n' "$PIE_BIN" > "$HOST_WRAPPER"
chmod +x "$HOST_WRAPPER"

# 扩展 ID 由打包时注入（build-pkg.sh 替 __EXT_ID__）；此处 host manifest 已就绪于模板拷贝
sed -e "s|__PIE_BIN__|$HOST_WRAPPER|g" \
    "$(dirname "$0")/ai.wiseria.pie.host.template.json" > "$NM_DIR/ai.wiseria.pie.json"

# launchd
sed -e "s|__PIE_BIN__|$PIE_BIN|g" -e "s|__LOG__|$PIE_DIR/logs/daemon.err.log|g" \
    "$(dirname "$0")/ai.wiseria.pie.plist.template" > "$LA_DIR/ai.wiseria.pie.plist"
launchctl unload "$LA_DIR/ai.wiseria.pie.plist" 2>/dev/null || true
launchctl load "$LA_DIR/ai.wiseria.pie.plist"

echo "[pie] installed. run 'pie doctor' to verify."
