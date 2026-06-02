#!/usr/bin/env bash
# 一键准备 eval 工具链(不含 WebArena docker 站点 —— 那个用 setup-webarena-site.sh)。
# 幂等:可反复跑。从仓库根目录执行: eval/setup.sh
#
# 装好:
#   1. dist-eval/         —— 带 __pieEval 的 eval 构建(pnpm build:eval)
#   2. eval/.venv/        —— Python venv + webarena-verified 评估器(离线打分)
#   3. Playwright chromium —— orchestrator 启浏览器用的二进制
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "==> [1/3] 构建 eval 扩展 (dist-eval/)"
pnpm build:eval >/dev/null
echo "    ✓ dist-eval 就绪"

echo "==> [2/3] Python venv + scorer 依赖 (eval/.venv/)"
# webarena-verified 要求 Python >= 3.11
PY=""
for cand in python3.11 python3.12 python3.13 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver=$("$cand" -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo 0)
    major=${ver%%.*}; minor=${ver##*.}
    if [ "$major" = "3" ] && [ "$minor" -ge 11 ] 2>/dev/null; then PY="$cand"; break; fi
  fi
done
if [ -z "$PY" ]; then
  echo "    ✗ 找不到 Python >= 3.11(webarena-verified 必需)。" >&2
  echo "      macOS: brew install python@3.11 ;然后重跑本脚本。" >&2
  exit 1
fi
echo "    使用 $PY ($($PY --version 2>&1))"
if [ ! -d eval/.venv ]; then
  "$PY" -m venv eval/.venv
fi
eval/.venv/bin/pip install --quiet --upgrade pip
eval/.venv/bin/pip install --quiet -r eval/scorer/requirements.txt
echo "    ✓ scorer 依赖就绪 ($(eval/.venv/bin/python -c 'import webarena_verified as w; print("webarena-verified", getattr(w,"__version__","?"))' 2>/dev/null || echo 'webarena-verified 已装'))"

echo "==> [3/3] Playwright chromium 二进制"
pnpm exec playwright install chromium >/dev/null
echo "    ✓ chromium 就绪"

echo ""
echo "工具链准备完成 ✅"
echo "下一步:起一个 WebArena 站点(如 shopping_admin):"
echo "    eval/setup-webarena-site.sh shopping_admin"
echo "然后跑任务(带你的 key):见 eval/README.md"
