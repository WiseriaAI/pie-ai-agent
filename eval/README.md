# WebArena-Verified Eval Harness

End-to-end evaluation of the Pie agent against the 812-task
[WebArena-Verified](https://github.com/ServiceNow/webarena-verified) benchmark.

---

## Architecture overview

```
eval/run-task.sh
  ├─ pnpm eval:task <task.json> <outRoot>   ← orchestrator (TypeScript)
  │    launches Chrome + Pie, runs the task, writes artifact bundle
  └─ eval/.venv/bin/python eval/scorer/score.py <run_dir>
       reads the bundle, calls the offline webarena-verified evaluator,
       writes <run_dir>/score.json
```

The scorer and its 812-task dataset are **fully offline** — no live web
application (Docker) is needed for the scoring step. Docker is only needed
during the orchestrator step so the agent can actually browse the app.

---

## One-time setup

### 1. Start WebArena Docker

Follow the official guide:
<https://github.com/web-arena-x/webarena/blob/main/environment_docker/README.md>

After the containers are up, note each site's host:port. You will need these
in two places:
- Each task's `webarenaHosts` array (so the HAR scrubber keeps that traffic).
- The `PIE_EVAL_ENVIRONMENTS` env var at score time (so the evaluator can
  resolve `__GITLAB__` / `__SHOPPING__` etc. to the actual base URL in the HAR).

Example environments mapping (JSON, one-line for export):
```
PIE_EVAL_ENVIRONMENTS='{"gitlab":{"urls":["http://localhost:8023"]},"shopping":{"urls":["http://localhost:7770"]},"shopping_admin":{"urls":["http://localhost:7780/admin"]},"reddit":{"urls":["http://localhost:9999"]},"map":{"urls":["http://localhost:3000"]}}'
```

### 2. Build the extension

```bash
pnpm build:eval
```

This produces `dist-eval/` which the orchestrator loads into Chrome.

### 3. Install the scorer venv

> **Python ≥ 3.11 is required.** Python 3.9 (macOS system default) is not
> supported by `webarena-verified` and will raise an incompatibility error.

```bash
python3.11 -m venv eval/.venv
eval/.venv/bin/pip install --upgrade pip
eval/.venv/bin/pip install -r eval/scorer/requirements.txt
```

### 4. Install the Playwright browser

```bash
pnpm exec playwright install chromium
```

---

## Run one task

Export the required env vars, then invoke the glue script:

```bash
export PIE_EVAL_PROVIDER=anthropic
export PIE_EVAL_MODEL=claude-sonnet-4-5
export PIE_EVAL_API_KEY=sk-ant-...

# Required for navigate/mutate tasks; for retrieve tasks it is optional
# (the evaluator will auto-detect the base URL from the HAR, with a warning).
export PIE_EVAL_ENVIRONMENTS='{"shopping_admin":{"urls":["http://localhost:7780/admin"]}}'

eval/run-task.sh eval/tasks/0.json
```

**Optional: pre-seed authentication** — set `PIE_EVAL_AUTH` to a JSON array of `AuthConfig` objects so the agent starts each task already logged in (mirrors WebArena's official eval pre-injection). If unset, auth-seeding is skipped.

```bash
export PIE_EVAL_AUTH='[{"loginUrl":"http://localhost:7780/admin","usernameField":"input[name=\"login[username]\"]","passwordField":"input[name=\"login[password]\"]","username":"admin","password":"admin1234","successUrlContains":"/admin/"}]'
```

The script writes all artifacts under `eval/runs/<taskId>-<timestamp>/` and
prints the final `score.json` to stdout.

---

## Task file format

Files live in `eval/tasks/`. Shape:

```jsonc
{
  "taskId": "0",            // WebArena task id, 0–811 (string, coerced to int by scorer)
  "goal": "...",            // natural-language instruction passed to the agent
  "startUrl": "http://localhost:7770/",   // URL the browser navigates to first
  "evalType": "info-seeking",             // "info-seeking" | "state-changing"
  "webarenaHosts": ["localhost"]          // hosts kept in the scrubbed HAR
}
```

`evalType` values:
- `"info-seeking"` — retrieve / answer-only tasks
- `"state-changing"` — mutate or navigate tasks

See `eval/tasks/0.json` for a worked example.

---

## Artifact bundle contents

After a run, `eval/runs/<taskId>-<stamp>/` contains:

| File | Description |
|------|-------------|
| `task.json` | Copy of the input task definition |
| `run.json` | `EvalTrace`: sessionId, answer, agentSelfReport, steps, usage, timing |
| `answer.txt` | Agent's final answer as plain text (also stored in `run.json`) |
| `network.har` | Scrubbed HAR of all network traffic during the task |
| `meta.json` | Harness metadata (version, timings, Chrome build) |
| `score.json` | Scoring result (written by the scorer after the run) |

**Ground-truth pass/fail is `score.json.score`** — `1.0` = pass, `0.0` = fail.

`run.json.agentSelfReport` is the agent's own assessment (observation only,
not ground truth). Do not use it as a benchmark metric.

---

## Status meanings

### Run-level (`run.json.status` / orchestrator exit)

| Status | Meaning |
|--------|---------|
| `done` | Agent completed and reported a final answer |
| `timeout` | Agent exceeded the per-task time limit |
| `error` | Agent encountered a recoverable error |
| `harness-error` | Orchestrator / Chrome setup failed (exit code 2) |

### Scorer-level (`score.json.status`)

| Status | Meaning |
|--------|---------|
| `scored` | Evaluator ran successfully; `score.json.score` is valid |
| `scorer-error` | Evaluator failed (see `score.json.error`); `score.json.score` is `null` |

**Only runs where `score.json.status == "scored"` count toward benchmark metrics.**

---

## Scorer is fully offline

The `webarena-verified` package bundles all 812 task definitions
(`webarena_verified/assets/dataset/webarena-verified.json`, ~927 KB). No
network calls, no database reads, no Docker access is made during scoring.

For navigate and mutate tasks the scorer inspects the HAR for matching network
events (URL path, HTTP method, POST body, query params). It resolves
`__GITLAB__` / `__SHOPPING_ADMIN__` etc. against `PIE_EVAL_ENVIRONMENTS` to
match the actual base URL present in the HAR — but it never contacts the live
app.

For retrieve (info-seeking) tasks the scorer only checks the agent's answer
against the bundled ground truth; the HAR is not used for scoring (though it
must still be a valid non-empty HAR file, as the evaluator validates it).

---

## Evaluator contract

Full API surface, input/output schemas, and empirical test results are
documented in `eval/EVALUATOR_CONTRACT.md`.
