#!/usr/bin/env bash
# eval/run-batch.sh — Run a batch of tasks sequentially, score each, then aggregate.
#
# Usage:
#   PIE_EVAL_PROVIDER=... PIE_EVAL_MODEL=... PIE_EVAL_API_KEY=... \
#   [PIE_EVAL_ENVIRONMENTS=...] [PIE_EVAL_TIMEOUT_MS=...] \
#   eval/run-batch.sh <outRoot> <task.json> [<task.json> ...]
#
# Unlike run-task.sh, a single task failing (timeout / harness-error / scorer-error)
# does NOT abort the batch — the loop is deliberately fault-tolerant so one bad task
# can't sink a long baseline run. Each run dir is appended to <outRoot>/_runs.txt and
# the batch ends with an aggregate report (eval/aggregate.py).
set -uo pipefail   # intentionally NOT -e

OUT_ROOT="${1:?usage: run-batch.sh <outRoot> <task.json>...}"; shift
if [ "$#" -eq 0 ]; then echo "run-batch.sh: no task files given" >&2; exit 1; fi

mkdir -p "$OUT_ROOT"
# Append, don't truncate: lets an incremental batch accumulate run dirs into an
# existing outRoot (the aggregate then covers all of them). For a clean baseline,
# `rm -rf "$OUT_ROOT"` before invoking.
MANIFEST="$OUT_ROOT/_runs.txt"; touch "$MANIFEST"

TOTAL="$#"; i=0
for TASK_JSON in "$@"; do
  i=$((i + 1))
  echo ""
  echo "############## [$i/$TOTAL] $TASK_JSON ##############"
  RUN_LINE=$(pnpm -s eval:task "$TASK_JSON" "$OUT_ROOT" 2>&1 | tee /dev/stderr | grep "runDir=" || true)
  RUN_DIR="${RUN_LINE##*runDir=}"
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ]; then
    eval/.venv/bin/python eval/scorer/score.py "$RUN_DIR" || echo "scorer failed for $RUN_DIR" >&2
    echo "$RUN_DIR" >> "$MANIFEST"
  else
    echo "run-batch.sh: no runDir for $TASK_JSON (harness-error?)" >&2
  fi
done

echo ""
echo "############## aggregate ##############"
eval/.venv/bin/python eval/aggregate.py "$OUT_ROOT"
