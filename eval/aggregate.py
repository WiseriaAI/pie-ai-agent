"""
eval/aggregate.py — Aggregate a batch of scored run dirs into one baseline report.

Reads every run directory listed in <outRoot>/_runs.txt (one path per line; written
by run-batch.sh), or, if that file is absent, every immediate subdir of <outRoot>
that has a score.json. For each run it pulls (taskId, type, score, agent answer) and
— for failures — the dataset's ground-truth expected answer (via the same
webarena_verified package the scorer uses), so the failure mode is visible inline.

Usage:
    eval/.venv/bin/python eval/aggregate.py <outRoot>

Prints a per-task table + an overall pass rate, and writes <outRoot>/_summary.json.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def expected_answer(wa, task_id: int) -> str:
    try:
        t = wa.get_task(task_id)
        resp = t.expected_agent_response
        rd = getattr(resp, "retrieved_data", None)
        return "" if rd is None else "; ".join(str(x) for x in rd)
    except Exception as exc:
        return f"<expected lookup failed: {exc!r}>"


def truncate(s: str, n: int = 60) -> str:
    s = s.replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def main(out_root: Path) -> int:
    runs_file = out_root / "_runs.txt"
    if runs_file.exists():
        run_dirs = [Path(line.strip()) for line in runs_file.read_text().splitlines() if line.strip()]
    else:
        run_dirs = sorted(p for p in out_root.iterdir() if p.is_dir() and (p / "score.json").exists())

    from webarena_verified.api import WebArenaVerified
    wa = WebArenaVerified()

    rows = []
    for rd in run_dirs:
        score_j = load_json(rd / "score.json") or {}
        run_j = load_json(rd / "run.json") or {}
        task_j = load_json(rd / "task.json") or {}
        task_id = score_j.get("taskId")
        if task_id is None and task_j.get("taskId") is not None:
            task_id = int(task_j["taskId"])
        score = score_j.get("score")
        status = score_j.get("status")  # scored | scorer-error
        # run.json (EvalTrace) has no run-level status field, so derive a useful
        # signal: a harness error, or the agent's own success self-report.
        if run_j.get("error"):
            run_status = "error"
        else:
            self_ok = (run_j.get("agentSelfReport") or {}).get("success")
            run_status = "self:ok" if self_ok else ("self:no" if self_ok is False else "?")
        answer = (run_j.get("answer") or "").strip()
        rows.append({
            "taskId": task_id,
            "score": score,
            "scorerStatus": status,
            "runStatus": run_status,
            "answer": answer,
            "expected": expected_answer(wa, int(task_id)) if task_id is not None else "",
            "runDir": str(rd),
        })

    rows.sort(key=lambda r: (r["taskId"] is None, r["taskId"]))

    scored = [r for r in rows if r["scorerStatus"] == "scored" and r["score"] is not None]
    passed = [r for r in scored if r["score"] == 1.0]
    pass_rate = (len(passed) / len(scored)) if scored else 0.0

    # ── table ──────────────────────────────────────────────────────────────
    print(f"\n{'task':>5}  {'score':>5}  {'run':>8}  {'answer':<32}  {'expected':<32}")
    print("-" * 96)
    for r in rows:
        mark = "✅" if r["score"] == 1.0 else ("❌" if r["score"] == 0.0 else "⚠️ ")
        sc = "-" if r["score"] is None else f"{r['score']:.0f}"
        print(f"{str(r['taskId']):>5}  {mark}{sc:>3}  {str(r['runStatus']):>8}  "
              f"{truncate(r['answer'], 32):<32}  {truncate(r['expected'], 32):<32}")

    print("-" * 96)
    print(f"scored: {len(scored)}/{len(rows)}   passed: {len(passed)}   "
          f"PASS RATE: {pass_rate:.1%}")
    non_scored = [r for r in rows if r not in scored]
    if non_scored:
        print(f"not-scored (excluded from rate): "
              f"{[(r['taskId'], r['runStatus'] or r['scorerStatus']) for r in non_scored]}")

    summary = {
        "total": len(rows),
        "scored": len(scored),
        "passed": len(passed),
        "passRate": pass_rate,
        "rows": rows,
    }
    (out_root / "_summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\n[aggregate] wrote {out_root}/_summary.json")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <outRoot>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(Path(sys.argv[1])))
