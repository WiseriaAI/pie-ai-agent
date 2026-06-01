"""
Golden tests for eval/scorer/score.py.

Run via:
    eval/.venv/bin/python -m pytest eval/scorer/test_score.py -v

Both tests use task_id=0 (retrieve), which is empirically confirmed to expect
["Quest Lumaflex™ Band"] from the bundled webarena-verified dataset.

The tests invoke score.py as a subprocess using the same Python interpreter
(which must be the venv python 3.11), then inspect the written score.json.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Minimal valid HAR (≥1 entry required by the evaluator).
# For retrieve tasks, the HAR is not used for scoring (AgentResponseEvaluator
# only), but the evaluator still requires the file to be non-empty.
# ---------------------------------------------------------------------------
MINIMAL_HAR = {
    "log": {
        "version": "1.2",
        "creator": {"name": "test", "version": "1.0"},
        "entries": [
            {
                "startedDateTime": "2024-01-01T00:00:00Z",
                "time": 1,
                "request": {
                    "method": "GET",
                    "url": "http://localhost:7770/",
                    "httpVersion": "HTTP/1.1",
                    "headers": [],
                    "queryString": [],
                    "cookies": [],
                    "headersSize": -1,
                    "bodySize": -1,
                },
                "response": {
                    "status": 200,
                    "statusText": "OK",
                    "httpVersion": "HTTP/1.1",
                    "headers": [],
                    "cookies": [],
                    "content": {"size": 0, "mimeType": "text/html"},
                    "redirectURL": "",
                    "headersSize": -1,
                    "bodySize": -1,
                },
                "cache": {},
                "timings": {"send": 0, "wait": 1, "receive": 0},
            }
        ],
    }
}

# Minimal EvalTrace structure matching eval/runner/types.ts
def make_run_json(answer: str, success: bool) -> dict:
    return {
        "sessionId": "test-session",
        "agentSelfReport": {"success": success, "summary": "test"},
        "answer": answer,
        "steps": [],
        "usage": {"inputTokens": 0, "outputTokens": 0},
        "startedAt": 0,
        "endedAt": 1,
        "error": None,
    }


def make_run_dir(tmp_path: Path, answer: str, success: bool) -> Path:
    """Build a minimal run directory for task 0 (retrieve)."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    # task.json — taskId as string to exercise int coercion
    (run_dir / "task.json").write_text(
        json.dumps({
            "taskId": "0",
            "goal": "Get the top-1 best-selling product name(s) in 2022",
            "startUrl": "http://localhost:7780/admin",
            "evalType": "info-seeking",
            "webarenaHosts": ["localhost"],
        }),
        encoding="utf-8",
    )

    # run.json (EvalTrace)
    (run_dir / "run.json").write_text(
        json.dumps(make_run_json(answer, success)),
        encoding="utf-8",
    )

    # answer.txt (redundant but exercises both code paths)
    (run_dir / "answer.txt").write_text(answer, encoding="utf-8")

    # network.har — must have ≥1 entry
    (run_dir / "network.har").write_text(
        json.dumps(MINIMAL_HAR),
        encoding="utf-8",
    )

    return run_dir


def run_scorer(run_dir: Path) -> dict:
    """Invoke score.py as a subprocess and return the parsed score.json."""
    score_py = Path(__file__).parent / "score.py"
    result = subprocess.run(
        [sys.executable, str(score_py), str(run_dir)],
        capture_output=True,
        text=True,
    )
    # Print output for debugging in CI
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)

    score_file = run_dir / "score.json"
    assert score_file.exists(), (
        f"score.json was not written. returncode={result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    return json.loads(score_file.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_correct_answer_scores_1(tmp_path: Path) -> None:
    """Correct answer 'Quest Lumaflex™ Band' → score 1.0."""
    run_dir = make_run_dir(tmp_path, answer="Quest Lumaflex™ Band", success=True)
    score = run_scorer(run_dir)

    assert score["status"] == "scored", f"Expected 'scored', got: {score}"
    assert score["score"] == 1.0, f"Expected score=1.0, got: {score['score']}"
    assert score["taskId"] == 0
    assert score["evaluator"] == "webarena-verified"
    assert "evaluatorVersion" in score


def test_wrong_answer_scores_0(tmp_path: Path) -> None:
    """Wrong answer 'Fitness Pants' → score 0.0."""
    run_dir = make_run_dir(tmp_path, answer="Fitness Pants", success=True)
    score = run_scorer(run_dir)

    assert score["status"] == "scored", f"Expected 'scored', got: {score}"
    assert score["score"] == 0.0, f"Expected score=0.0, got: {score['score']}"
