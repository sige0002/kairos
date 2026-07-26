"""bagflow ``report.json`` -> kairos ``summary.json`` (the adapter lives here).

Two report formats meet in this module. bagflow reports **per node**: every node
publishes whatever dicts it wants on its ``result`` stream (``{check, ok, …}`` by
convention), plus a per-edge ``coverage`` block and the list of nodes that died
before end-of-stream (``incomplete``). kairos consumes a **flat summary**:
``{pipeline, version, result, message, metrics, …}``, rendered by the generic
frontend ``SummaryResult`` with no pipeline-specific UI code.

The overall pass/fail verdict is decided HERE — bagflow deliberately has no notion
of one (it reports facts; a check's ``ok`` is per check). The rule:

* any check with ``ok: false`` -> **fail** (this includes the source's own
  ``source_read``, so a truncated/corrupt MCAP fails the run);
* any node in ``incomplete`` -> **fail**: it died before end-of-stream, so the
  checks it was supposed to run simply did not happen and "no failures" would be
  a lie;
* no check results at all -> **fail** (a flow that validated nothing);
* ``coverage`` below the job's ``min_coverage`` -> **fail**. Coverage is how much
  of the bag each edge actually saw; queue overflow shows up here rather than as a
  silent gap. The default (0) reports coverage without gating on it, because a
  sampled check is still a real check — raise it per flow when a verdict must be
  backed by the whole recording.
"""

from __future__ import annotations

from typing import Any

from kairos_common import utc_now_iso8601

# Pipeline identity stamped into the summary (same contract as validation.py).
PIPELINE_ID = "full_validation"
PIPELINE_VERSION = "1.0.0"

# Ratio keys bagflow writes per coverage entry (topic subscription / node edge).
_RATIO_KEYS = ("ratio_vs_bag", "ratio_vs_upstream")


def _checks(report: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten ``results: {node: [record, …]}`` into rows tagged with their node."""
    rows: list[dict[str, Any]] = []
    results = report.get("results")
    if not isinstance(results, dict):
        return rows
    for node, records in results.items():
        if not isinstance(records, list):
            continue
        for record in records:
            if isinstance(record, dict):
                rows.append({"node": str(node), **record})
    return rows


def _coverage_min(report: dict[str, Any]) -> float | None:
    """Smallest coverage ratio across every edge, or ``None`` when unknown.

    ``None`` is honest rather than optimistic: a bag without ``metadata.yaml``
    gives bagflow no expected counts, so there is no ratio to compare against.
    """
    coverage = report.get("coverage")
    if not isinstance(coverage, dict):
        return None
    ratios = [
        float(entry[key])
        for entry in coverage.values()
        if isinstance(entry, dict)
        for key in _RATIO_KEYS
        if isinstance(entry.get(key), (int, float))
    ]
    return min(ratios) if ratios else None


def _incomplete(report: dict[str, Any]) -> list[str]:
    """Nodes that never sent end-of-stream (bagflow names them ``result_<node>``)."""
    raw = report.get("incomplete")
    if not isinstance(raw, list):
        return []
    return [str(item).removeprefix("result_") for item in raw]


def _label(check: dict[str, Any]) -> str:
    name = check.get("check")
    node = check.get("node", "?")
    return f"{node}.{name}" if name else str(node)


def _pct(ratio: float | None) -> float | None:
    return None if ratio is None else round(ratio * 100, 1)


def _message(
    *,
    total: int,
    failed: list[dict[str, Any]],
    incomplete: list[str],
    coverage_min: float | None,
    min_coverage: float,
    wall_s: float | None,
) -> str:
    """One human-readable headline (the ``message`` the UI shows prominently)."""
    parts: list[str] = []
    if incomplete:
        parts.append(
            f"{len(incomplete)} node(s) did not finish: {', '.join(incomplete)}"
        )
    if failed:
        names = ", ".join(_label(check) for check in failed[:4])
        more = "" if len(failed) <= 4 else f" (+{len(failed) - 4})"
        parts.append(f"{len(failed)}/{total} checks failed: {names}{more}")
    elif total and not incomplete:
        parts.append(f"{total}/{total} checks passed")
    if not total:
        parts.append("no check produced a result")
    if coverage_min is not None:
        gate = "" if min_coverage <= 0 else f" (min {_pct(min_coverage)}%)"
        parts.append(f"coverage {_pct(coverage_min)}%{gate}")
    if wall_s is not None:
        parts.append(f"{wall_s:.2f}s")
    return " · ".join(parts)


def summarize(
    report: dict[str, Any],
    *,
    flow: str,
    run_id: str,
    min_coverage: float = 0.0,
    wall_s: float | None = None,
) -> dict[str, Any]:
    """Build the kairos summary for one bagflow report.

    *wall_s* is the wall time kairos measured for the whole ``bagflow run`` (the
    report's own ``wall_s`` covers only the report node's lifetime).
    """
    checks = _checks(report)
    failed = [check for check in checks if check.get("ok") is False]
    incomplete = _incomplete(report)
    coverage_min = _coverage_min(report)
    coverage_short = (
        min_coverage > 0 and coverage_min is not None and coverage_min < min_coverage
    )
    passed = not failed and not incomplete and bool(checks) and not coverage_short

    bag = report.get("bag")
    bag_info = (
        # `topics` is a per-topic count/Hz map that can run to dozens of entries;
        # it stays in report.json (an artifact) instead of bloating every summary.
        {key: value for key, value in bag.items() if key != "topics"}
        if isinstance(bag, dict)
        else {}
    )

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "result": "pass" if passed else "fail",
        "message": _message(
            total=len(checks),
            failed=failed,
            incomplete=incomplete,
            coverage_min=coverage_min,
            min_coverage=min_coverage,
            wall_s=wall_s,
        ),
        "checked_at": utc_now_iso8601(),
        "flow": flow,
        "run_id": run_id,
        "metrics": {
            "checks_total": len(checks),
            "checks_failed": len(failed),
            # `coverage` (0-100) is the shared convention the Validation screen
            # reads for its per-episode coverage column.
            "coverage": _pct(coverage_min),
            "min_coverage_required": _pct(min_coverage) if min_coverage > 0 else None,
            "wall_s": None if wall_s is None else round(wall_s, 3),
            "flow_wall_s": report.get("wall_s"),
        },
        "checks": checks,
        "incomplete": incomplete,
        "bag": bag_info,
        # Per-edge counts, kept under an unambiguous key: `coverage` at the top
        # level is read as a NUMBER by the frontend's outcome mapping.
        "edge_coverage": report.get("coverage", {}),
    }
    return summary
