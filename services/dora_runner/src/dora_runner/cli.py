"""Local CLI for iterating on validation without the HTTP server.

The whole point is fast, debuggable iteration: point it at a recorded run and
it runs the ``fast_validation`` dataflow in-process, prints the summary, and
writes ``report/fast_validation/<run_id>/summary.json`` — no uvicorn, no job
queue, no orchestrator. Swap the template and re-run to try different rules.

Usage::

    uv run python -m dora_runner.cli <run_id> [--data-dir DIR]
                                    [--template FILE] [--json]
    # or, once installed: dora-validate <run_id> ...

``--template`` is a YAML or JSON file matching :class:`ValidationTemplate`
(``name`` / ``version`` / ``required_topics: [{name, type?}]``); omit it to
auto-generate a draft template from the run's own topics. Exit code is ``0`` on
pass, ``1`` on fail (handy in scripts/CI).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from dora_runner.models import ValidationTemplate
from dora_runner.validation import generate_template, run_fast_validation


def _load_template(path: Path) -> ValidationTemplate:
    """Load a validation template from a YAML/JSON file (YAML is a JSON superset)."""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return ValidationTemplate.model_validate(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dora-validate",
        description="Run fast_validation against a recorded run, locally.",
    )
    parser.add_argument("run_id", help="run id under <data-dir>/recorded/")
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path("./data"),
        help="data root containing recorded/<run_id>/ (default ./data)",
    )
    parser.add_argument(
        "--template",
        type=Path,
        help="template YAML/JSON; omit to auto-generate from the run's topics",
    )
    parser.add_argument(
        "--json", action="store_true", help="print the raw summary JSON only"
    )
    args = parser.parse_args(argv)

    template = (
        _load_template(args.template)
        if args.template
        else generate_template(args.run_id, args.data_dir)
    )
    result = run_fast_validation(
        run_id=args.run_id, data_dir=args.data_dir, template=template
    )
    summary = result["summary"]

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"run:      {args.run_id}")
        print(
            f"template: {summary['template']['name']} v{summary['template']['version']}"
        )
        print(f"result:   {summary['result'].upper()}")
        if summary["missing"]:
            print("missing:")
            for item in summary["missing"]:
                suffix = f" [{item['type']}]" if item.get("type") else ""
                print(f"  - {item['name']}{suffix}")
        print(f"extra:    {len(summary['extra'])} topic(s) not in template")
        print(f"report:   {result['artifacts'][0]}")

    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
