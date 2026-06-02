# WebArena-Verified Evaluator Contract

Frozen from empirical spike on 2026-06-01.
Package version: `webarena-verified==1.2.3` (commit `6473f72`).

---

## 1. Install

### Python requirement

**Python ≥ 3.11 is required** (the package declares `requires-python >= ">=3.11"`).
Python 3.9 (macOS system default) raises `Package 'webarena-verified' requires a different Python: 3.9.6 not in '>=3.11'`.

### Command that worked

```bash
python3.11 -m venv eval/.venv
source eval/.venv/bin/activate
pip install --upgrade pip
pip install "git+https://github.com/ServiceNow/webarena-verified.git"
```

The PyPI package `browsergym-webarena-verified` also fails on Python < 3.12 (`Requires-Python >=3.12`), so the GitHub source install is the right route.

---

## 2. Import paths and API surface

### Top-level facade (recommended)

```python
from webarena_verified.api import WebArenaVerified
```

### Lower-level building blocks (used internally)

```python
from webarena_verified.api import WebArenaVerifiedEvaluator   # orchestrator
from webarena_verified.api import WebArenaVerifiedDataReader   # dataset loader
from webarena_verified.types.config import WebArenaVerifiedConfig
from webarena_verified.types.eval import TaskEvalResult, EvalStatus, EvaluatorResult
from webarena_verified.types.tracing import NetworkTrace
from webarena_verified.types.agent_response import FinalAgentResponse
```

---

## 3. Primary entry point: `WebArenaVerified`

```python
class WebArenaVerified:
    def __init__(
        self,
        *,
        config: Path | WebArenaVerifiedConfig | None = None
    ) -> None: ...

    def evaluate_task(
        self,
        *,
        task_id: int,
        agent_response: str | dict | list | None | Path,
        network_trace: list[dict] | Path | NetworkTrace,
    ) -> TaskEvalResult: ...

    def get_task(self, task_id: int) -> WebArenaVerifiedTask: ...
    def get_tasks(
        self,
        sites: list[WebArenaSite] | None = None,
        template_id: int | None = None,
        action: MainObjectiveType | None = None,
    ) -> list[WebArenaVerifiedTask]: ...
```

---

## 4. Inputs

### 4a. `config` (constructor, optional)

`WebArenaVerifiedConfig` or `None`. Controls:
- `test_data_file: Path` — dataset JSON (defaults to the bundled `assets/dataset/webarena-verified.json`; no download needed).
- `environments: dict[WebArenaSite, EnvironmentConfig] | None` — maps site placeholders (e.g. `"gitlab"`, `"shopping"`, `"shopping_admin"`) to live instance URLs. Required for `NetworkEventEvaluator` tasks (navigate + most mutate) so that `__GITLAB__` etc. can be resolved to the actual base URL present in the HAR.

Minimal config example:

```python
from webarena_verified.types.config import WebArenaVerifiedConfig

config = WebArenaVerifiedConfig(
    environments={
        "gitlab":         {"urls": ["http://localhost:8023"]},
        "shopping":       {"urls": ["http://localhost:7770"]},
        "shopping_admin": {"urls": ["http://localhost:7780/admin"]},
        "reddit":         {"urls": ["http://localhost:9999"]},
        "map":            {"urls": ["http://localhost:3000"]},
    }
)
wa = WebArenaVerified(config=config)
```

If `environments` is `None`, the evaluator attempts a best-effort auto-correction by extracting the base URL from the first network event in the trace. This works for single-site tasks but emits a warning and is unreliable for multi-site tasks.

### 4b. `task_id: int`

Integer task ID (0–811). The bundled dataset has exactly 812 tasks.

### 4c. `agent_response`

The agent's final answer. Accepted types:

| Type | Semantics |
|------|-----------|
| `dict` | Structured answer; must conform to `FinalAgentResponse` schema (see below) — **recommended format** |
| `str` | Raw text; the evaluator attempts to parse JSON from it; plain strings score 0 for retrieve tasks |
| `list` | List of values; treated as retrieved_data directly (may cause validation failure) |
| `None` | No response; results in failure |
| `Path` | File path; the file is read as text and treated as str |

**`FinalAgentResponse` schema (the dict structure you must produce):**

```json
{
  "task_type": "retrieve" | "mutate" | "navigate",
  "status": "SUCCESS" | "FAILURE",
  "retrieved_data": ["item1", "item2"] | null,
  "error_details": null | "reason string"
}
```

- `task_type` and `status` are case-insensitive (normalised internally).
- `retrieved_data` must be `null` for `mutate` and `navigate` tasks; for `retrieve` tasks it is a list of strings (or numbers/objects for certain tasks — the task's `results_schema` specifies the exact type).
- `error_details` must be `null` when status is `SUCCESS`.

### 4d. `network_trace`

The browser's network activity. Accepted types:

| Type | Semantics |
|------|-----------|
| `Path` (`.har` or `.json`) | HAR file; loaded and parsed automatically |
| `Path` (`.zip` or directory) | Playwright trace zip/directory; loaded automatically |
| `list[dict]` | Pre-parsed entries; autodetected as HAR entries (if they have `request`/`response` keys) or Playwright events |
| `NetworkTrace` | Pre-constructed object |

**Minimum valid HAR (as file or list):**

The HAR **must have at least one entry**. An empty `"entries": []` raises `ValueError: "HAR file contains no entries"`.

Minimal HAR file structure:
```json
{
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
          "bodySize": -1
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
          "bodySize": -1
        },
        "cache": {},
        "timings": {"send": 0, "wait": 1, "receive": 0}
      }
    ]
  }
}
```

**Navigate task requirement:** The `NetworkEventEvaluator` for navigate tasks looks for `is_navigation_event == True`, which requires the request to carry browser navigation headers:

```json
"headers": [
  {"name": "Accept",         "value": "text/html,application/xhtml+xml,..."},
  {"name": "Sec-Fetch-Dest", "value": "document"},
  {"name": "Sec-Fetch-Mode", "value": "navigate"},
  {"name": "Sec-Fetch-User", "value": "?1"}
]
```

A real Playwright/Chrome HAR will contain these headers automatically. A hand-crafted minimal HAR without them will fail the `NetworkEventEvaluator` assertion even if the URL is correct.

---

## 5. Output: `TaskEvalResult`

```python
class TaskEvalResult(BaseModel):
    task_id:                          int
    intent_template_id:               int
    sites:                            tuple[WebArenaSite, ...]
    task_revision:                    int
    status:                           EvalStatus            # "success" | "failure" | "error"
    score:                            float                 # 1.0 = pass, 0.0 = fail/error
    evaluators_results:               tuple[EvaluatorResult, ...]
    error_msg:                        str | None            # set only when status == "error"
    webarena_verified_version:        str                   # e.g. "1.2.3"
    webarena_verified_evaluator_checksum: str
    webarena_verified_data_checksum:  str
```

**Score semantics:** Binary — `1.0` (all sub-evaluators passed) or `0.0` (any failure or error). No partial credit. `EvalStatus.PARTIAL_MATCH` is defined in the enum but not emitted by the current scoring logic.

### `EvalStatus` enum

```python
class EvalStatus(StrEnum):
    SUCCESS       = "success"
    PARTIAL_MATCH = "partial_match"   # defined but not currently used
    FAILURE       = "failure"
    ERROR         = "error"
```

### `EvaluatorResult` (per-evaluator breakdown)

```python
class EvaluatorResult(BaseModel):
    evaluator_name:    str           # "AgentResponseEvaluator" | "NetworkEventEvaluator"
    status:            EvalStatus
    score:             float         # 1.0 or 0.0
    actual:            Any | None    # what the evaluator extracted from the agent response / trace
    actual_normalized: Any | None    # after normalization
    expected:          Any | None    # the expected value (from task definition)
    assertions:        tuple[EvalAssertion, ...] | None
    error_msg:         str | None
    should_not_exist:  bool | None
```

### Accessing the score

```python
result = wa.evaluate_task(task_id=0, agent_response=..., network_trace=...)
passed = result.score == 1.0          # bool
status = result.status                # EvalStatus string
breakdown = result.evaluators_results # per-evaluator detail
```

---

## 6. Dataset

**The 812-task dataset ships with the package.** No separate download needed.

- Bundled path: `webarena_verified/assets/dataset/webarena-verified.json` (~927 KB, 812 tasks).
- Also bundled: `webarena-verified-hard.json` (516 KB), `subsets/webarena-verified-hard.json`, `subsets/webarena-verified-non-hard.json`.
- Loaded automatically on `WebArenaVerified()` construction. A custom `test_data_file` path can be supplied via `WebArenaVerifiedConfig`.
- Loading requires exactly 812 tasks; partial files are rejected with `ValueError`.

---

## 7. Task-type support matrix

| Task type | Evaluators used | Needs live env? | Offline from (answer + HAR)? |
|-----------|----------------|-----------------|------------------------------|
| **retrieve** (info-seeking) | `AgentResponseEvaluator` only | No | ✅ Yes — pure answer-match, HAR unused for scoring |
| **navigate** | `AgentResponseEvaluator` + `NetworkEventEvaluator` | No | ✅ Yes — HAR must contain a real browser navigation event (sec-fetch headers); Playwright HAR satisfies this automatically |
| **mutate** (state-changing) | `AgentResponseEvaluator` + `NetworkEventEvaluator` | No | ✅ Yes — HAR is inspected for matching network events (URL path, HTTP method, POST body, query params); no live DB read required |

**All three task types can be scored fully offline from (answer + HAR) alone, with no live database.**

The evaluator never reads from or writes to the live web application. URL templates (e.g. `__GITLAB__`) are resolved against the `environments` config to match the base URL present in the HAR; no HTTP connection is made during scoring.

### Distribution (812 tasks)

| task_type | count |
|-----------|-------|
| retrieve  | 325   |
| mutate    | 374   |
| navigate  | 113   |

- 812 tasks use `AgentResponseEvaluator` (all tasks).
- 663 tasks additionally use `NetworkEventEvaluator` (navigate + most mutate tasks).

---

## 8. Empirical test results

```
# Task 0 (retrieve): "Get the top-1 best-selling product name(s) in 2022"
# Expected: ["Quest Lumaflex™ Band"]

evaluate_task(task_id=0, agent_response={"task_type":"retrieve","status":"SUCCESS","retrieved_data":["Quest Lumaflex™ Band"]}, ...)
→ score=1.0, status="success"

evaluate_task(task_id=0, agent_response={"task_type":"retrieve","status":"SUCCESS","retrieved_data":["Fitness Pants"]}, ...)
→ score=0.0, status="failure"

# Task 44 (navigate): "Open my todos page"
# Requires GET to <gitlab>/dashboard/todos with browser nav headers

evaluate_task(task_id=44, agent_response={"task_type":"navigate","status":"SUCCESS","retrieved_data":null},
              network_trace=[HAR entry with sec-fetch-dest=document headers + URL /dashboard/todos])
→ score=1.0, status="success"

# Task 389 (mutate/POST): "Post 'Thanks, working on reviews' for the merge request..."
# Requires POST to <gitlab>/primer/design/notes with correct JSON body and query params

evaluate_task(task_id=389, agent_response={"task_type":"mutate","status":"SUCCESS","retrieved_data":null},
              network_trace=[HAR POST entry with matching body])
→ score=1.0, status="success"

evaluate_task(task_id=389, agent_response={"task_type":"mutate","status":"SUCCESS","retrieved_data":null},
              network_trace=[HAR POST entry with wrong note text])
→ score=0.0, status="failure"
```

---

## 9. Minimal usage example

```python
from pathlib import Path
from webarena_verified.api import WebArenaVerified
from webarena_verified.types.config import WebArenaVerifiedConfig

# Configure with the URLs your agent actually used
config = WebArenaVerifiedConfig(
    environments={
        "gitlab":         {"urls": ["http://localhost:8023"]},
        "shopping":       {"urls": ["http://localhost:7770"]},
        "shopping_admin": {"urls": ["http://localhost:7780/admin"]},
        "reddit":         {"urls": ["http://localhost:9999"]},
        "map":            {"urls": ["http://localhost:3000"]},
    }
)
wa = WebArenaVerified(config=config)

# Retrieve task
result = wa.evaluate_task(
    task_id=0,
    agent_response={
        "task_type": "retrieve",
        "status": "SUCCESS",
        "retrieved_data": ["Quest Lumaflex™ Band"],
    },
    network_trace=Path("run/task_0/network.har"),   # or a list of dicts
)
print(result.score)   # 1.0 or 0.0
print(result.status)  # "success" | "failure" | "error"
```

---

## 10. Caveats / unknowns

- `EvalStatus.PARTIAL_MATCH` is present in the enum but never emitted by the current scoring code; the score is always binary (1.0 / 0.0).
- When `environments` is `None` (no config), the evaluator auto-corrects using the first network trace URL as the base URL. This is fragile; always supply an explicit `environments` config.
- The HAR **must not be empty** (≥ 1 entry required). Pass a dummy entry for purely answer-match (retrieve) tasks.
- Navigate tasks require real browser navigation headers (`Sec-Fetch-*`) in the HAR to be detected as navigation events. A Playwright-captured HAR will have these automatically.
- The `webarena_verified_evaluator_checksum` field in `TaskEvalResult` is a hash of the evaluator source code, not the data. It can be used to detect evaluator version drift across runs.
