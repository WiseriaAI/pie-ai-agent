#!/usr/bin/env bash
# 用法:
#   PIE_EVAL_PROVIDER=anthropic \
#   PIE_EVAL_MODEL=<model-id> \
#   PIE_EVAL_API_KEY=<key> \
#   [PIE_EVAL_ENVIRONMENTS='{"shopping_admin":{"urls":["http://localhost:7780/admin"]},...}'] \
#   eval/run-task.sh <task.json> [outRoot]
#
# 前置条件:
#   - pnpm build:eval 已生成 dist-eval/
#   - WebArena docker 已启动并可访问 (仅 orchestrator 步骤需要)
#   - eval/.venv 已安装 scorer (python3.11 -m venv eval/.venv && eval/.venv/bin/pip install -r eval/scorer/requirements.txt)
set -euo pipefail

TASK_JSON="${1:?usage: run-task.sh <task.json> [outRoot]}"
OUT_ROOT="${2:-eval/runs}"

# ── 1. Orchestrator: 跑 agent, 产出 artifact bundle。捕获 runDir ────────────
RUN_LINE=$(pnpm -s eval:task "$TASK_JSON" "$OUT_ROOT" | tee /dev/stderr | grep "runDir=")
RUN_DIR="${RUN_LINE##*runDir=}"

if [ -z "$RUN_DIR" ]; then
  echo "run-task.sh: could not determine runDir from orchestrator output" >&2
  exit 1
fi

# ── 2. Scorer: 离线确定性打分 (python3.11 venv, 无需 docker) ─────────────────
eval/.venv/bin/python eval/scorer/score.py "$RUN_DIR"

echo "=== score.json ==="
cat "$RUN_DIR/score.json"
