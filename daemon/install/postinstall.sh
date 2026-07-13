#!/bin/bash
# daemon/install/postinstall.sh — .pkg 装完后由 macOS Installer 以 root 运行（非用户上下文）。
# 所有 per-user 路径须显式解析真实登录的 console user，不能用裸 $HOME（root 下 = /var/root）。
set -euo pipefail

# 解析真实登录的 console user（而非 root）
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ] || [ "$CONSOLE_USER" = "loginwindow" ]; then
  echo "[pie] error: no logged-in console user detected (got '${CONSOLE_USER:-<empty>}')." >&2
  echo "[pie] please log into the Mac's GUI session and re-run this installer, or run 'pie doctor' after logging in to finish setup." >&2
  exit 1
fi

USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $NF}')"
USER_UID="$(id -u "$CONSOLE_USER")"

if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
  echo "[pie] error: could not resolve home directory for console user '$CONSOLE_USER'." >&2
  exit 1
fi

# 系统级二进制：装在 /usr/local/bin，root-owned 正确
PIE_BIN="/usr/local/bin/pie"
HOST_WRAPPER="/usr/local/bin/pie-host"

# per-user 路径：一律基于真实用户的 $USER_HOME，绝不用裸 $HOME（root 下 $HOME=/var/root）
PIE_DIR="$USER_HOME/.pie"
NM_DIR="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LA_DIR="$USER_HOME/Library/LaunchAgents"

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

# per-user 文件是以 root 写的，交还给真实用户，否则该用户的 launchd/Chrome 会话读不到 / 没权限
chown -R "$CONSOLE_USER" "$PIE_DIR"
chown "$CONSOLE_USER" "$NM_DIR/ai.wiseria.pie.json"
chown "$CONSOLE_USER" "$LA_DIR/ai.wiseria.pie.plist"

# 装进该用户的 gui/<uid> session domain，而非 root 的 domain
launchctl asuser "$USER_UID" launchctl unload "$LA_DIR/ai.wiseria.pie.plist" 2>/dev/null || true
launchctl asuser "$USER_UID" launchctl load "$LA_DIR/ai.wiseria.pie.plist"

# 顶栏 app：登录自启 + 装完立即启动（图标出现 = 安装成功反馈）
if [ -d "/Applications/Pie Link.app" ]; then
  cp "$(dirname "$0")/ai.wiseria.pie.menubar.plist.template" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  chown "$CONSOLE_USER" "$LA_DIR/ai.wiseria.pie.menubar.plist"
  launchctl asuser "$USER_UID" launchctl unload "$LA_DIR/ai.wiseria.pie.menubar.plist" 2>/dev/null || true
  launchctl asuser "$USER_UID" launchctl load "$LA_DIR/ai.wiseria.pie.menubar.plist"
fi

echo "[pie] installed. run 'pie doctor' to verify."
