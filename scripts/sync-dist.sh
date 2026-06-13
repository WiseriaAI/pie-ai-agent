#!/usr/bin/env bash
#
# sync-dist.sh — 把当前 worktree 的构建产物同步到主仓库（主分支检出）的 dist/。
#
# 背景：开发新功能默认在 worktree 里做（见 CLAUDE.md「本地开发约定」）。
# Chrome 的「Load unpacked」一次性指向主仓库 dist/，之后只认这个路径。所以
# 在 worktree build 出来的产物，需要复制到主仓库 dist/，Chrome 刷新即可测到新代码——
# 无需每次去 chrome://extensions 重新指向 worktree 路径。
#
# 用法：在 worktree 内运行（cwd = 任意 worktree 子目录均可）
#   pnpm build && pnpm sync:dist
#   # 或直接： bash scripts/sync-dist.sh
#
# 路径全靠 git 自发现，与脚本被放在哪个 worktree 副本无关。
#
# 注意：所有变量展开都用 ${VAR} 花括号定界。本脚本的提示语含中文全角标点，
# 在非 UTF-8 locale 下 $VAR 紧贴全角字符会被并进变量名，必须用 ${VAR} 隔开。

set -euo pipefail

# 当前所在 worktree 的顶层（用 cwd 判定）
SRC="$(git rev-parse --show-toplevel)"

# 主仓库（主工作树）永远是 `git worktree list` 的第一条
MAIN="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

if [ "${SRC}" = "${MAIN}" ]; then
  echo "ℹ️  当前已在主仓库（${MAIN}），无需同步 dist。"
  echo "    若想测试某个 worktree 的产物，请在那个 worktree 里运行本脚本。"
  exit 0
fi

if [ ! -d "${SRC}/dist" ]; then
  echo "❌ 源 dist 不存在：${SRC}/dist" >&2
  echo "   请先在该 worktree 里跑 \`pnpm build\`。" >&2
  exit 1
fi

echo "→ 同步 dist：${SRC}/dist  ⇒  ${MAIN}/dist"
rsync -a --delete "${SRC}/dist/" "${MAIN}/dist/"
echo "✅ 完成。去 chrome://extensions 点扩展卡片上的刷新按钮即可加载新代码。"
