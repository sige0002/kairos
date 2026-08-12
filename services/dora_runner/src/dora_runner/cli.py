# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Local CLI for iterating on validation without the HTTP server.

The whole point is fast, debuggable iteration: point it at a capture and it
runs the ``fast_validation`` flow on dora, prints the summary, and writes
``report/fast_validation/<capture_id>/summary.json`` — no uvicorn, no job queue,
no orchestrator. Swap the template and re-run to try different rules.

It runs the same flow the service runs, so it needs the same bundled binaries
(bagflow + dora): use it inside the dora_runner image, e.g.

    docker compose exec dora_runner python -m dora_runner.cli <capture_id>

Usage::

    uv run python -m dora_runner.cli <capture_id> [--data-dir DIR]
                                    [--template FILE] [--flow NAME] [--json]
    # or, once installed: dora-validate <capture_id> ...

``--template`` is a YAML or JSON file matching :class:`ValidationTemplate`
(``name`` / ``version`` / ``required_topics: [{name, type?}]``); omit it to
auto-generate a draft template from the capture's own topics. Exit code is ``0`` on
pass, ``1`` on fail (handy in scripts/CI).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import yaml

from dora_runner.bagflow_runtime import DoraEndpoint, bagflow_available
from dora_runner.fast_validation import DEFAULT_FLOW, run_fast_validation
from dora_runner.models import ValidationTemplate
from dora_runner.validation import generate_template


def _load_template(path: Path) -> ValidationTemplate:
    """Load a validation template from a YAML/JSON file (YAML is a JSON superset)."""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return ValidationTemplate.model_validate(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dora-validate",
        description="Run fast_validation against one capture, locally.",
    )
    parser.add_argument("capture_id", help="capture id under <data-dir>/objects/")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("./data"),
        help="data root containing objects/<capture_id>/ (default ./data)",
    )
    parser.add_argument(
        "--template",
        type=Path,
        help="template YAML/JSON; omit to auto-generate from the capture's topics",
    )
    parser.add_argument(
        "--flow",
        default=DEFAULT_FLOW,
        help=(
            "flow name to run (default %(default)s): config/<robot>/flows/ first, "
            "then the flow bundled with the service"
        ),
    )
    parser.add_argument(
        "--json", action="store_true", help="print the raw summary JSON only"
    )
    args = parser.parse_args(argv)

    if not bagflow_available():
        print(
            "fast_validation runs on dora: the bagflow + dora binaries are only "
            "in the dora_runner image (try `docker compose exec dora_runner "
            "python -m dora_runner.cli ...`).",
            file=sys.stderr,
        )
        return 2

    template = (
        _load_template(args.template)
        if args.template
        else generate_template(args.capture_id, args.data_dir)
    )
    result = asyncio.run(
        run_fast_validation(
            capture_id=args.capture_id,
            data_dir=args.data_dir,
            endpoint=DoraEndpoint.from_env(),
            job_name=f"cli-{args.capture_id}",
            template=template,
            flow=args.flow,
        )
    )
    summary = result["summary"]

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"capture:  {args.capture_id}")
        print(
            f"template: {summary['template']['name']} v{summary['template']['version']}"
        )
        print(f"result:   {summary['result'].upper()}  ({summary['message']})")
        if summary["missing"]:
            print("missing:")
            for item in summary["missing"]:
                suffix = f" [{item['type']}]" if item.get("type") else ""
                reason = f"  — {item['reason']}" if item.get("reason") else ""
                print(f"  - {item['name']}{suffix}{reason}")
        print(f"extra:    {len(summary['extra'])} topic(s) not in template")
        print(f"report:   {result['artifacts'][0]}")

    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
