"""
eval/scorer/score.py — Offline deterministic scorer using webarena-verified.

Usage:
    python3.11 eval/scorer/score.py <run_dir>

Where <run_dir> contains:
    task.json      — required; must have "taskId" field (int or str-coercible to int)
    run.json       — optional EvalTrace: .answer, .agentSelfReport.success
    answer.txt     — fallback answer if run.json absent or has no answer
    network.har    — required by evaluator (must have ≥1 entry)

Output:
    <run_dir>/score.json  — scoring result

Environment:
    PIE_EVAL_ENVIRONMENTS  — optional JSON mapping sites to URLs, e.g.:
        '{"shopping": {"urls": ["http://localhost:7770"]}, ...}'
        If not set, environments=None (evaluator uses best-effort auto-detect).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main(run_dir: Path) -> int:
    """Score a run directory. Always writes <run_dir>/score.json.

    Returns 0 on a successful (scored) run, 1 on any scorer error. The
    scorer-error contract requires that EVERY invocation writes a score.json,
    so the entire body below is wrapped in one try/except — config parse,
    constructor, get_task, and evaluate_task failures all funnel into the
    scorer-error shape rather than crashing with no file written.
    """

    score_path = run_dir / "score.json"
    # Best-effort task id for the error path: set as soon as we parse it.
    task_id_for_err: int | None = None

    try:
        # ── 1. Read inputs ─────────────────────────────────────────────────────

        task_file = run_dir / "task.json"
        task_json = json.loads(task_file.read_text())
        task_id = int(task_json["taskId"])  # coerce str→int
        task_id_for_err = task_id  # record once known, for the error path

        # run.json (EvalTrace)
        run_file = run_dir / "run.json"
        answer: str | None = None
        agent_success: bool | None = None

        if run_file.exists():
            run_json = json.loads(run_file.read_text())
            answer = run_json.get("answer") or None
            self_report = run_json.get("agentSelfReport") or {}
            agent_success = self_report.get("success")  # bool or None

        # answer.txt fallback
        answer_file = run_dir / "answer.txt"
        if not answer and answer_file.exists():
            txt = answer_file.read_text().strip()
            if txt:
                answer = txt

        # ── 2. Construct WebArenaVerified ──────────────────────────────────────

        from webarena_verified.api import WebArenaVerified  # noqa: PLC0415
        from webarena_verified.types.config import WebArenaVerifiedConfig  # noqa: PLC0415

        env_json = os.environ.get("PIE_EVAL_ENVIRONMENTS")
        if env_json:
            environments = json.loads(env_json)
            config = WebArenaVerifiedConfig(environments=environments)
        else:
            config = None  # type: ignore[assignment]

        wa = WebArenaVerified(config=config)

        # ── 3. Determine task_type via get_task ────────────────────────────────
        #
        # WebArenaVerifiedTask exposes three boolean helpers:
        #   task.is_retrieve_task  → "retrieve"
        #   task.is_navigate_task  → "navigate"
        #   task.is_mutate_task    → "mutate"

        task_obj = wa.get_task(task_id)

        if task_obj.is_retrieve_task:
            task_type = "retrieve"
        elif task_obj.is_navigate_task:
            task_type = "navigate"
        elif task_obj.is_mutate_task:
            task_type = "mutate"
        else:
            # Defensive fallback — should never happen with the current 812-task dataset
            task_type = "retrieve"

        # ── 4. Build agent_response ────────────────────────────────────────────

        # Determine SUCCESS/FAILURE
        if agent_success is True:
            status = "SUCCESS"
        elif agent_success is False:
            status = "FAILURE"
        else:
            # No explicit self-report: infer from whether we have a non-empty answer
            status = "SUCCESS" if answer else "FAILURE"

        if task_type == "retrieve":
            # v1: wrap single answer string in a one-element list.
            # NOTE: multi-value and numeric retrieve tasks may need richer coercion
            # (e.g. splitting on commas, casting to int/float) guided by the task's
            # results_schema — this is out of scope for v1.
            retrieved_data = [answer] if answer else []
            if not retrieved_data:
                status = "FAILURE"
        else:
            # mutate / navigate: HAR carries the evidence; retrieved_data must be null
            retrieved_data = None  # type: ignore[assignment]

        agent_response: dict = {
            "task_type": task_type,
            "status": status,
            "retrieved_data": retrieved_data,
            "error_details": None,
        }

        # ── 5. Evaluate ────────────────────────────────────────────────────────

        network_trace_path = run_dir / "network.har"

        result = wa.evaluate_task(
            task_id=task_id,
            agent_response=agent_response,
            network_trace=network_trace_path,
        )

        # Build per-evaluator breakdown for details.
        # EvaluatorResult.actual / .expected can contain non-serialisable types
        # (mappingproxy, NormalizedString, etc.) — coerce to str for safety.
        def _safe(v: object) -> object:
            """Return v if JSON-serialisable, else its str() representation."""
            try:
                json.dumps(v)
                return v
            except (TypeError, ValueError):
                return str(v)

        details = {
            "evaluators": [
                {
                    "name": er.evaluator_name,
                    "score": float(er.score),
                    "status": str(er.status),
                    "actual": _safe(er.actual),
                    "expected": _safe(er.expected),
                }
                for er in result.evaluators_results
            ]
        }

        score_json = {
            "taskId": task_id,
            "evaluator": "webarena-verified",
            "evaluatorVersion": result.webarena_verified_version,
            "status": "scored",
            "score": float(result.score),
            "evalStatus": str(result.status),
            "details": details,
        }

        score_path.write_text(json.dumps(score_json, indent=2, ensure_ascii=False))
        print(f"[scorer] scored  score={float(result.score)}  evalStatus={result.status!s}")
        return 0

    except Exception as exc:  # noqa: BLE001
        score_json = {
            "taskId": task_id_for_err,
            "evaluator": "webarena-verified",
            "status": "scorer-error",
            "score": None,
            "error": repr(exc),
        }
        score_path.write_text(json.dumps(score_json, indent=2, ensure_ascii=False))
        print(f"[scorer] scorer-error  score=null  error={repr(exc)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <run_dir>", file=sys.stderr)
        sys.exit(1)

    sys.exit(main(Path(sys.argv[1])))
