"""
eval/gen-tasks.py — Generate Pie eval task files from the webarena-verified dataset.

Reads the bundled 812-task dataset via the same `webarena_verified` package the
scorer uses, filters by site, and emits one `eval/tasks/<id>.json` per task in the
harness's TaskDef shape. The goal text is the dataset's canonical `intent` (more
faithful to WebArena than hand-authored wording), and the scorer scores the
agent's answer against the dataset's own ground truth regardless.

Usage:
    eval/.venv/bin/python eval/gen-tasks.py --site shopping_admin [--type retrieve] [--out eval/tasks]

Idempotent: overwrites existing <id>.json files for the selected tasks.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from webarena_verified.api import WebArenaVerified

# Site placeholder → live base URL the local Docker stack serves. Mirrors
# eval/README.md's PIE_EVAL_ENVIRONMENTS and the scorer's environments config.
SITE_BASE_URL: dict[str, str] = {
    "shopping_admin": "http://localhost:7780/admin",
    "shopping": "http://localhost:7770",
    "gitlab": "http://localhost:8023",
    "reddit": "http://localhost:9999",
    "map": "http://localhost:3000",
}

# WebArena hosts kept by the HAR scrubber. All local sites are on localhost.
SITE_HOSTS: dict[str, list[str]] = {
    "shopping_admin": ["localhost"],
    "shopping": ["localhost"],
    "gitlab": ["localhost"],
    "reddit": ["localhost"],
    "map": ["localhost"],
}


def task_type(t) -> str:
    if t.is_retrieve_task:
        return "retrieve"
    if t.is_navigate_task:
        return "navigate"
    if t.is_mutate_task:
        return "mutate"
    return "retrieve"


def eval_type_for(ttype: str) -> str:
    # TaskDef.evalType: "info-seeking" (retrieve) | "state-changing" (navigate/mutate)
    return "info-seeking" if ttype == "retrieve" else "state-changing"


def resolve_start_url(placeholder_url: str, site: str) -> str:
    base = SITE_BASE_URL[site]
    # start_urls look like "__SHOPPING_ADMIN__" or "__SHOPPING_ADMIN__/catalog/product/edit/id/1481/"
    token = f"__{site.upper()}__"
    if placeholder_url.startswith(token):
        suffix = placeholder_url[len(token):]
        return base + suffix
    return placeholder_url


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, choices=sorted(SITE_BASE_URL))
    ap.add_argument("--type", choices=["retrieve", "navigate", "mutate"], default=None,
                    help="optional task-type filter; default = all types for the site")
    ap.add_argument("--out", default="eval/tasks")
    args = ap.parse_args()

    wa = WebArenaVerified()
    tasks = wa.get_tasks(sites=[args.site])

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for t in tasks:
        ttype = task_type(t)
        if args.type and ttype != args.type:
            continue
        # Single-site tasks only for v1: multi-site start_urls need per-site
        # resolution we don't model yet.
        if len(t.sites) != 1:
            continue
        start_url = resolve_start_url(t.start_urls[0], args.site)
        task_def = {
            "taskId": str(t.task_id),
            "goal": t.intent,
            "startUrl": start_url,
            "evalType": eval_type_for(ttype),
            "webarenaHosts": SITE_HOSTS[args.site],
        }
        (out_dir / f"{t.task_id}.json").write_text(
            json.dumps(task_def, indent=2, ensure_ascii=False) + "\n"
        )
        written.append((t.task_id, ttype))

    written.sort()
    by_type: dict[str, int] = {}
    for _, tt in written:
        by_type[tt] = by_type.get(tt, 0) + 1
    print(f"[gen-tasks] site={args.site} wrote {len(written)} task files to {out_dir}/")
    print(f"[gen-tasks] by type: {by_type}")
    print(f"[gen-tasks] ids: {[i for i, _ in written]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
