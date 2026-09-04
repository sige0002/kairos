#!/usr/bin/env python3
"""Compare two Kairos performance result files without hiding workload drift."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from perf_harness import (
    comparison_mismatches,
    render_comparison_markdown,
    validate_result_artifact,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Compare two perf result JSON files. The comparison is invalid when "
            "their workload manifests differ."
        )
    )
    parser.add_argument("baseline", type=Path, help="baseline result JSON")
    parser.add_argument("candidate", type=Path, help="candidate result JSON")
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="also write the Markdown report to this path",
    )
    return parser


def _load_result(path: Path) -> dict[str, Any]:
    """Load one result object and reject ambiguous non-object JSON."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"could not read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"result must be a JSON object: {path}")
    if value.get("schema_version") != "kairos.perf.result/v2":
        raise ValueError(
            f"unsupported result schema in {path}; expected kairos.perf.result/v2"
        )
    manifest = value.get("manifest")
    if not isinstance(manifest, dict):
        raise ValueError(f"result has no object manifest: {path}")
    try:
        validate_result_artifact(value)
    except ValueError as exc:
        raise ValueError(f"invalid cadence evidence in {path}: {exc}") from exc
    return value


def _write_text_atomic(path: Path, content: str) -> None:
    """Atomically replace *path* with the generated Markdown report."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main(argv: Sequence[str] | None = None) -> int:
    """Render the comparison and return non-zero for invalid input/workloads."""
    args = _parser().parse_args(argv)
    try:
        baseline = _load_result(args.baseline)
        candidate = _load_result(args.candidate)
        mismatches = comparison_mismatches(baseline["manifest"], candidate["manifest"])
        report = render_comparison_markdown(baseline, candidate)
        if mismatches and "INVALID COMPARISON" not in report:
            joined = "\n".join(f"- `{path}`" for path in mismatches)
            report = (
                f"# INVALID COMPARISON\n\nIncompatible workload fields:\n\n{joined}\n"
            )
        if args.output is not None:
            _write_text_atomic(args.output, report)
    except ValueError as exc:
        print(f"perf-compare: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"perf-compare: could not write report: {exc}", file=sys.stderr)
        return 2

    print(report, end="" if report.endswith("\n") else "\n")
    return 2 if mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
