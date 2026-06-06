"""
eval/classify-failures.py — Evidence-based failure attribution for a batch.

For every FAILED run (score 0.0) under <outRoot>, this computes OBJECTIVE signals
so failures are attributed to a layer by evidence, not by judgement:

  retrieve tasks — was each expected value (normalized) present
    · in the agent's ANSWER  → the agent found AND reported it; a 0.0 here means a
      scorer/format problem (would re-coercion flip it? — flagged FORMAT/SCORER)
    · in what the agent SAW (any trace observation) but not the answer → the agent
      saw it but didn't report it → AGENT:saw-but-didnt-report (reasoning/extraction)
    · nowhere → AGENT:never-found (navigation / search / data)

  navigate & mutate tasks — did the HAR contain a request matching the expected
    NetworkEventSpec (url + method)?
    · yes → the agent performed the action; a 0.0 is a scoring-detail/near-miss
      (e.g. post_data/query mismatch) → HARNESS-OR-NEARMISS
    · no, but a request to a similar path exists → AGENT:partial
    · no → AGENT:didnt-perform   (mutate may also be ENV:no-reset — flagged for
      manual trace review, since we don't snapshot-restore between tasks)

Output: prints a per-failure evidence block + category tally, and writes
<outRoot>/FAILURES.md. The automation is a FIRST PASS — every row carries its raw
evidence so the classification can be audited and overridden by reading the trace.

Usage:
    eval/.venv/bin/python eval/classify-failures.py eval/runs/strat60
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SHOPPING_ADMIN = "http://localhost:7780/admin"


def norm(s: str) -> str:
    """Approximate the evaluator's NormalizedString: lowercase, strip, drop
    surrounding quotes/punctuation/whitespace. Used only for presence checks."""
    s = str(s).lower().strip()
    return s.strip("\"'`.,;:!?()[]{}■ \t\n")


def load(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def expected_needles(t) -> list[str]:
    """Flatten a retrieve task's expected retrieved_data into atomic value strings."""
    rd = getattr(t.expected_agent_response, "retrieved_data", None) or []
    out: list[str] = []
    for item in rd:
        if isinstance(item, dict):
            out.extend(str(v) for v in item.values())
        else:
            out.append(str(item))
    return [n for n in (norm(x) for x in out) if n]


def trace_text(run_dir: Path) -> str:
    """Concatenate all text the agent emitted or observed (its whole IR)."""
    d = load(run_dir / "agent-trace.json")
    if not isinstance(d, list):
        return ""
    chunks: list[str] = []

    def walk(c):
        if isinstance(c, str):
            chunks.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    if b.get("type") == "text":
                        chunks.append(b.get("text", ""))
                    elif b.get("type") == "tool_use":
                        chunks.append(json.dumps(b.get("input", {}), ensure_ascii=False))
                    elif b.get("type") == "tool_result":
                        rc = b.get("content", "")
                        if isinstance(rc, list):
                            chunks.append(" ".join(x.get("text", "") for x in rc if isinstance(x, dict)))
                        else:
                            chunks.append(str(rc))
    for m in d:
        if isinstance(m, dict):
            walk(m.get("content"))
    return norm(" ".join(chunks))


def har_requests(run_dir: Path) -> list[tuple[str, str]]:
    """Return (method, url) for every HAR entry."""
    har = load(run_dir / "network.har")
    out = []
    try:
        for e in har["log"]["entries"]:
            req = e.get("request", {})
            out.append((req.get("method", ""), req.get("url", "")))
    except Exception:
        pass
    return out


def expected_event(t):
    """Return (method, url_pattern, is_regex) for a navigate/mutate task, resolved."""
    cfgs = t.network_event_evaluator_cfgs or []
    if not cfgs:
        return None
    spec = cfgs[0].expected
    url = (spec.url or "").replace("__SHOPPING_ADMIN__", SHOPPING_ADMIN)
    method = spec.http_method or "GET"
    is_regex = url.startswith("^") or url.endswith("$") or "\\" in url or "[" in url
    return (method, url, is_regex)


def url_matches(pattern: str, is_regex: bool, url: str) -> bool:
    if is_regex:
        try:
            return re.search(pattern, url) is not None
        except re.error:
            return False
    return pattern in url


def classify_retrieve(t, run_dir: Path, answer: str) -> tuple[str, dict]:
    # Special case: the ground truth is "no result" (NOT_FOUND_ERROR). The scorer
    # only ever emits SUCCESS/FAILURE, so it cannot credit a correct "none" — a
    # harness mapping gap (falsifiable: re-evaluating 183 with status
    # NOT_FOUND_ERROR flips it to 1.0). Whether the agent *deserves* credit depends
    # on it explicitly signalling "not found" rather than silently giving up.
    exp_status = str(getattr(t.expected_agent_response, "status", "")).upper()
    if exp_status.endswith("NOT_FOUND_ERROR"):
        return "HARNESS:not-found-mapping (expected=NOT_FOUND; scorer can't emit it)", {
            "expected_status": "NOT_FOUND_ERROR",
            "answer": answer[:160] or "(empty)",
            "note": "fix = prompt agent to signal 'not found' + score.py maps it",
        }

    needles = expected_needles(t)
    a = norm(answer)
    seen = trace_text(run_dir)
    in_answer = [n for n in needles if n in a]
    in_trace = [n for n in needles if n in seen]
    # The evaluator does SET equality — extra values are wrong too. Build the
    # answer's own value set to detect over-inclusion (all-correct-present is not
    # enough; the agent must not add wrong extras).
    ans_set = set()
    try:
        parsed = json.loads(answer.strip())
        items = parsed if isinstance(parsed, list) else [parsed]
        for it in items:
            if isinstance(it, dict):
                ans_set |= {norm(v) for v in it.values()}
            else:
                ans_set.add(norm(it))
    except Exception:
        ans_set = {norm(answer)}
    ans_set.discard("")
    exp_set = set(needles)
    extras = ans_set - exp_set
    ev = {
        "expected_values": needles,
        "in_answer": f"{len(in_answer)}/{len(needles)}",
        "in_trace_observations": f"{len(in_trace)}/{len(needles)}",
        "extra_values_in_answer": sorted(extras)[:6],
        "answer": answer[:160],
    }
    if needles and len(in_answer) == len(needles) and not extras:
        return "FORMAT/SCORER (exact value set present but scored 0)", ev
    if needles and exp_set <= ans_set and extras:
        return "AGENT:over-inclusion (all correct + extra WRONG values)", ev
    if needles and len(in_trace) == len(needles):
        return "AGENT:saw-but-didnt-report", ev
    if needles and in_trace:
        return "AGENT:partial (saw some values)", ev
    return "AGENT:never-found", ev


def har_requests_full(run_dir: Path) -> list[tuple[str, str, str]]:
    """(method, url, post_body_text) for every HAR entry."""
    har = load(run_dir / "network.har")
    out = []
    try:
        for e in har["log"]["entries"]:
            req = e.get("request", {})
            body = (req.get("postData", {}) or {}).get("text", "") or ""
            out.append((req.get("method", ""), req.get("url", ""), body))
    except Exception:
        pass
    return out


def expected_post_data(t) -> dict:
    cfgs = t.network_event_evaluator_cfgs or []
    if not cfgs:
        return {}
    return getattr(cfgs[0].expected, "post_data", None) or {}


def post_data_check(expected_pd: dict, body: str) -> tuple[int, int, list]:
    """How many expected key=value pairs appear in the request body.
    Bodies are multipart form-data: name="key"\\n\\nvalue. We look for the
    key, then check the expected value follows it. Returns (hits, total, misses)."""
    total = len(expected_pd)
    hits, misses = 0, []
    nbody = body.replace("\r\n", "\n")
    for k, v in expected_pd.items():
        # find the field block for key k, capture its value up to the next boundary
        m = re.search(r'name="%s"\s*\n\s*\n(.*?)(?:\n-{4,}|\Z)' % re.escape(k), nbody, re.S)
        actual = (m.group(1).strip() if m else None)
        if actual is not None and norm(actual) == norm(str(v)):
            hits += 1
        else:
            misses.append(f"{k}: expected={v!r} actual={actual!r}")
    return hits, total, misses


def classify_event(t, run_dir: Path, ttype: str) -> tuple[str, dict]:
    exp = expected_event(t)
    reqs = har_requests(run_dir)
    if not exp:
        return "UNKNOWN (no expected event cfg)", {"har_requests": len(reqs)}
    method, pat, is_regex = exp
    matched = [u for (m, u) in reqs if m == method and url_matches(pat, is_regex, u)]
    # When url+method match, the verdict hinges on post_data: right action +
    # right value = harness scoring issue; right action + WRONG value = agent.
    if matched:
        exp_pd = expected_post_data(t)
        if exp_pd:
            full = har_requests_full(run_dir)
            best = (0, len(exp_pd), ["no body"])
            for (m, u, body) in full:
                if m == method and url_matches(pat, is_regex, u) and body:
                    hits, tot, misses = post_data_check(exp_pd, body)
                    if hits > best[0]:
                        best = (hits, tot, misses)
            hits, tot, misses = best
            ev = {"expected": f"{method} {pat}", "har_match": len(matched),
                  "post_data": f"{hits}/{tot} fields correct", "mismatches": misses[:4]}
            if hits == tot:
                return "HARNESS-OR-NEARMISS (action + all field values correct; scoring detail)", ev
            return "AGENT:near-miss (right page/action, WRONG field value)", ev
        # navigate (no post_data): url+method match = agent navigated; 0 likely a
        # HAR nav-header (sec-fetch) detection issue.
        return "HARNESS-OR-NEARMISS (navigate hit; check HAR nav headers)", {
            "expected": f"{method} {pat}", "har_match": len(matched)}
    # similar path (same first path segment) for partial signal
    base_path = re.sub(r"[\^\$].*", "", pat.replace(SHOPPING_ADMIN, "")).strip("/").split("/")[:2]
    base = "/".join(base_path)
    similar = [u for (_, u) in reqs if base and base in u]
    ev = {
        "expected": f"{method} {pat}",
        "har_match": len(matched),
        "har_similar_path": len(similar),
        "har_total": len(reqs),
    }
    if matched:
        return "HARNESS-OR-NEARMISS (agent made the request; scoring detail e.g. post_data)", ev
    if similar:
        tag = "AGENT:partial (hit the area, not the exact event)"
    else:
        tag = "AGENT:didnt-perform"
    if ttype == "mutate":
        tag += "  [also check ENV:no-reset — manual trace review]"
    return tag, ev


def main(out_root: Path) -> int:
    from webarena_verified.api import WebArenaVerified
    wa = WebArenaVerified()

    run_dirs = sorted(p for p in out_root.iterdir() if p.is_dir() and (p / "score.json").exists())
    failures = []
    for rd in run_dirs:
        sj = load(rd / "score.json") or {}
        if sj.get("status") != "scored" or sj.get("score") == 1.0:
            continue
        tid = sj.get("taskId")
        if tid is None:
            continue
        t = wa.get_task(int(tid))
        ttype = "retrieve" if t.is_retrieve_task else "navigate" if t.is_navigate_task else "mutate"
        rj = load(rd / "run.json") or {}
        answer = (rj.get("answer") or "").strip()
        if ttype == "retrieve":
            cat, ev = classify_retrieve(t, rd, answer)
        else:
            cat, ev = classify_event(t, rd, ttype)
        failures.append({"taskId": int(tid), "type": ttype, "category": cat,
                         "intent": t.intent, "evidence": ev, "runDir": rd.name})

    failures.sort(key=lambda f: (f["type"], f["taskId"]))

    # tally
    tally: dict[str, int] = {}
    for f in failures:
        head = f["category"].split(" ")[0]
        tally[head] = tally.get(head, 0) + 1

    lines = ["# Failure attribution — evidence-based first pass", "",
             f"Batch: `{out_root}`  ·  {len(failures)} failures", "",
             "Category tally (by head):", ""]
    for k, v in sorted(tally.items(), key=lambda x: -x[1]):
        lines.append(f"- **{k}**: {v}")
    lines += ["", "Legend: `FORMAT/SCORER`,`HARNESS-OR-NEARMISS` = harness/scorer layer; "
              "`AGENT:*` = agent capability; `ENV:no-reset` = shared-env pollution (mutate).", "",
              "---", ""]
    for f in failures:
        lines.append(f"## task {f['taskId']} [{f['type']}] — {f['category']}")
        lines.append(f"- intent: {f['intent']}")
        for k, v in f["evidence"].items():
            lines.append(f"- {k}: `{v}`")
        lines.append(f"- runDir: `{f['runDir']}`")
        lines.append("")

    (out_root / "FAILURES.md").write_text("\n".join(lines))
    print("\n".join(lines[:8]))
    print(f"\n[classify] {len(failures)} failures → {out_root}/FAILURES.md")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <outRoot>", file=sys.stderr)
        sys.exit(1)
    sys.exit(main(Path(sys.argv[1])))
