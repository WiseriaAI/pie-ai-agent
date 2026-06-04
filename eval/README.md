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

## Quickstart (new device, low-cost onboarding)

Two idempotent scripts do all setup. From the repo root:

```bash
# 1. Toolchain: build:eval + scorer venv (Python ≥3.11) + Playwright chromium.
#    No docker / API key needed. Safe to re-run.
eval/setup.sh

# 2. A WebArena site (default shopping_admin). Downloads ~9.6GB (resumable),
#    docker load + run + configures base_url. Idempotent.
eval/setup-webarena-site.sh shopping_admin

# 3. Run a task (your BYOK key). Auth config for shopping_admin is committed.
export PIE_EVAL_PROVIDER=anthropic PIE_EVAL_MODEL=<model-id> PIE_EVAL_API_KEY=<key>
export PIE_EVAL_AUTH="$(cat eval/auth/shopping-admin.json)"
export PIE_EVAL_TIMEOUT_MS=900000          # optional; default 600000 (10min)
eval/run-task.sh eval/tasks/0.json
```

> **Apple Silicon (arm64) note:** WebArena images are amd64. Magento's php-fpm
> **crashes (SIGSEGV → HTTP 502) under qemu** user-mode emulation. You must enable
> Docker Desktop → Settings → General → **"Use Rosetta for x86/amd64 emulation"**
> and restart Docker Desktop. `setup-webarena-site.sh` detects and warns about this.

Re-onboarding on a fresh machine = clone repo → `pnpm install` → the 3 steps above.
The big cost is the one-time ~9.6GB image download; everything else is fast.

---

## One-time setup (manual — what the scripts above automate)

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

**Optional: pre-seed authentication** — set `PIE_EVAL_AUTH` to a JSON array of `AuthConfig` objects so the agent starts each task already logged in (mirrors WebArena's official eval pre-injection). If unset, auth-seeding is skipped. Login-gated sites (shopping_admin, gitlab, reddit-as-user) need it; public retrieve tasks don't.

A ready-made config for shopping_admin (WebArena's public test creds `admin`/`admin1234`) is committed at `eval/auth/shopping-admin.json`:

```bash
export PIE_EVAL_AUTH="$(cat eval/auth/shopping-admin.json)"
```

Each `AuthConfig`: `{loginUrl, usernameField, passwordField, username, password, successUrlContains?}` (the field selectors are CSS/name selectors; `successUrlContains` is a substring the post-login URL should contain). See `eval/runner/auth.ts`.

The script writes all artifacts under `eval/runs/<taskId>-<timestamp>/` and
prints the final `score.json` to stdout.

---

## Run a multi-task baseline

A single task is statistical noise. To get a measurable pass rate, generate a
pool of task files from the dataset, run a batch, and aggregate.

**1. Generate task files** from the bundled webarena-verified dataset (`intent`
is used verbatim as the goal; one `eval/tasks/<id>.json` per task):

```bash
# all retrieve (info-seeking) tasks for shopping_admin — 86 files
eval/.venv/bin/python eval/gen-tasks.py --site shopping_admin --type retrieve
# or all types for a site (retrieve + navigate + mutate)
eval/.venv/bin/python eval/gen-tasks.py --site shopping_admin
```

**2. Run a batch** (fault-tolerant: one task failing/timing-out does NOT abort
the batch; each run dir is recorded and the batch ends with an aggregate report):

```bash
export PIE_EVAL_PROVIDER=... PIE_EVAL_MODEL=... PIE_EVAL_API_KEY=...
export PIE_EVAL_ENVIRONMENTS='{"shopping_admin":{"urls":["http://localhost:7780/admin"]}}'
rm -rf eval/runs/baseline        # for a clean baseline (the batch appends otherwise)
eval/run-batch.sh eval/runs/baseline eval/tasks/0.json eval/tasks/11.json eval/tasks/41.json
```

**3. Aggregate** (re-runnable standalone; globs every scored run dir under the
root, prints a per-task table + pass rate, writes `_summary.json`). The table
shows the agent answer vs the dataset's ground-truth expected value inline, so
failure modes are visible at a glance:

```bash
eval/.venv/bin/python eval/aggregate.py eval/runs/baseline
```

> **Answer format ↔ scorer coercion.** The evaluator compares `retrieved_data`
> **element-wise** (set/list equality). The agent is instructed (eval bridge) to
> reply with a **bare value** for single answers and a **JSON array** for
> multi-value / per-item answers; the scorer's `coerce_retrieved_data`
> (`score.py`) parses that JSON so multi-value answers match. A comma-joined
> string is wrapped as ONE element and will NOT match a multi-value expected set
> — this is why the JSON-array directive matters.

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

---

## Status & next steps

**The harness is validated end-to-end** (launch → auth-seed → agent drives the
real site → HAR captured → offline deterministic scoring). Design/plan:
- `docs/specs/2026-06-01-webarena-verified-eval-harness.md`
- `docs/plans/2026-06-01-webarena-verified-eval-harness.md`

### Harness hardening (the eval bridge was too thin)

The thin eval bridge (`src/background/eval-bridge.ts`) drove `runAgentLoop`
directly but skipped capability pre-wiring the real extension does at chat-start.
Four harness-layer fixes (each with a regression test in
`src/background/eval-bridge*.test.ts`):

1. **seedConfig SW-restart robustness** — `startTask` resolves the model config
   from the *persisted* active instance (`resolveActiveInstanceModelConfig`), not
   an in-memory pointer. MV3 can evict the SW during the orchestrator's
   `page.goto` between `seedConfig` and `startTask`; the in-memory pointer didn't
   survive, the persisted one does.
2. **CDP input pre-grant** — `seedConfig` sets `cdp_input_enabled = true`. There's
   no sidepanel in the headless harness, so the click/type tools would otherwise
   fail at `requestCdpInputConsent` ("no sidepanel port"). Mirrors WebArena's
   official permission pre-injection.
3. **SessionMeta pre-seed** — `startTask` writes a `SessionMeta` + `SessionAgent`
   keyed by the eval `sessionId`, so the pinned-tab registry works: without it,
   `open_url`'s `appendPinnedTab` is a silent no-op and `focus_tab` can never
   operate on a newly opened tab.
4. **Value-only / JSON-array answer directive** — the task prompt instructs a
   bare value for single answers and a **JSON array** for multi-value / per-item
   answers. The scorer's `AgentResponseEvaluator` compares the normalized answer
   for **element-wise set equality** (no substring/containment), so a verbose
   sentence never matches, and a comma-joined multi-value string is wrapped as one
   element and never matches a multi-value expected set.
5. **Scorer answer coercion** (`coerce_retrieved_data` in `score.py`, covered by
   `eval/scorer/test_score.py`) — the agent's answer is parsed **JSON-first**: a
   JSON array → a list (matched element-wise), a JSON object/scalar → a
   one-element list, plain text → a single bare value. The v1 `[answer]` wrapping
   put the *entire* multi-value/structured answer into one string element, so
   every such retrieve task was unmatchable even when the content was correct.

### Baseline (the methodology fix: measure before tuning)

A single task is statistical noise. `eval/gen-tasks.py` + `eval/run-batch.sh` +
`eval/aggregate.py` turn the dataset into a measurable pass rate. On a 19-task
shopping_admin retrieve baseline (one task per intent template, model
`deepseek/deepseek-v4-pro`):

| Stage | Change | Pass rate |
|-------|--------|-----------|
| Initial | harness fixes 1–4 only | 11/19 = 57.9% |
| + coercion (fix 5) | parse the agent's JSON-array answers | 15/19 = 78.9% |
| + JSON-array directive (fix 4) | multi-value answers emitted parseably | 16/19 = 84.2% |
| + re-run variance | a "couldn't find email" task succeeded on retry | **17/19 = 89.5%** |

Most of the lift was **harness/scorer-layer**, on the *same* model runs: fixes 4
and 5 recovered five tasks whose content was already correct but whose format the
scorer couldn't match. This is the "improve harness capability" goal — measure
first, then the recovered tasks reveal that the bridge, not the model, was the
bottleneck.

**Remaining failures are genuine agent effectiveness** (2/19): an aggregation
task that picked the wrong "most orders" customer (62), and a grid-filter task
that returned an empty answer (183). The 243 flip (prose-giveup → correct email
on retry) shows some failures are run-to-run variance, not deterministic — a
larger sample or self-consistency voting would smooth that. Per-run
`agent-trace.json` (full raw LLM IR: reasoning + tool calls + observations) is
written for exactly this kind of step-by-step diagnosis.
