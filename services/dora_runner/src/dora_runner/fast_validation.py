"""``fast_validation`` — the required-topic gate, running on bagflow/dora.

This is the pipeline every recording goes through: *does this bag contain the
topics the operator declared mandatory?* It used to be a pure-Python comparison
inside this service; it is now the bundled bagflow flow
``services/dora_runner/flows/fast_validation.yml`` executed on the service's own
dora coordinator, exactly like ``full_validation`` (see ``bagflow_pipeline``).

**Fast stays fast.** The flow subscribes to no topic, so no MCAP message is read
or decoded: ``bagflow-topic-presence`` judges from the bag's ``metadata.yaml``
inventory alone, and the cost is the dataflow's own startup — flat in bag size,
whether the recording is 30 MB or 4 GB.

The verdict shape is unchanged (``result`` / ``missing`` / ``extra`` /
``template``), because the Validation screen renders a bespoke required-topic
checklist from it. What is new in the summary is bagflow's own evidence
(``checks``, ``metrics``, ``engine``), which the generic renderer would show for
any other pipeline.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from kairos_common import ValidationTemplate, utc_now_iso8601

from dora_runner.bagflow_flow import bundled_flows_dir, flows_dir
from dora_runner.bagflow_pipeline import FlowOutcome, run_bagflow_pipeline
from dora_runner.bagflow_runtime import DoraEndpoint
from dora_runner.bagflow_summary import (
    check_label,
    flatten_checks,
    incomplete_nodes,
)

# Pipeline identity stamped into the summary. v2 = the bagflow/dora engine; v1
# was the in-process comparison, same verdict fields.
PIPELINE_ID = "fast_validation"
PIPELINE_VERSION = "2.0.0"

# The bundled flow's name. An operator may shadow it with a file of the same
# name under config/<robot>/flows/ (resolve order: robot config, then bundled).
DEFAULT_FLOW = "fast_validation"

# The check node whose record carries the required-topic verdict.
PRESENCE_CHECK = "topic_presence"


def flow_search_dirs() -> list[Path]:
    """Where ``fast_validation`` looks for its flow, in precedence order."""
    return [flows_dir(), bundled_flows_dir()]


def _presence(checks: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The ``topic_presence`` record, or ``None`` when the flow produced none."""
    for check in checks:
        if check.get("check") == PRESENCE_CHECK:
            return check
    return None


def _topics(value: Any) -> list[dict[str, Any]]:
    """A list-of-topic-dicts field from the check record, defensively typed."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _message(
    *,
    presence: dict[str, Any] | None,
    missing: list[dict[str, Any]],
    failed: list[dict[str, Any]],
    incomplete: list[str],
    wall_s: float | None,
) -> str:
    """One human-readable headline (the ``message`` the UI shows prominently)."""
    parts: list[str] = []
    if incomplete:
        parts.append(
            f"{len(incomplete)} node(s) did not finish: {', '.join(incomplete)}"
        )
    if presence is None:
        parts.append("the flow produced no topic_presence result")
    else:
        required = presence.get("required", 0)
        matched = presence.get("matched", 0)
        if not required:
            # A template with no required topics can only ever pass; say so
            # rather than reporting "0/0 matched" as if something was checked.
            parts.append("the template declares no required topics — nothing checked")
        elif missing:
            names = ", ".join(str(topic.get("name")) for topic in missing[:4])
            more = "" if len(missing) <= 4 else f" (+{len(missing) - 4})"
            parts.append(f"{len(missing)} required topic(s) missing: {names}{more}")
        else:
            # `required` counts PATTERNS and `matched` counts TOPICS — one glob
            # can cover several — so they are reported as separate quantities
            # rather than as a single "matched/required" ratio.
            parts.append(
                f"{required}/{required} required topic pattern(s) matched "
                f"({matched} topic(s))"
            )
        if presence.get("bag_metadata") is False:
            parts.append(str(presence.get("reason", "no bag metadata")))
    # Any other failing check (today: the source's own read health) still belongs
    # in the headline — the verdict counts it.
    others = [check for check in failed if check.get("check") != PRESENCE_CHECK]
    if others:
        parts.append(f"also failed: {', '.join(check_label(c) for c in others)}")
    if wall_s is not None:
        parts.append(f"{wall_s:.2f}s")
    return " · ".join(parts)


def summarize(outcome: FlowOutcome) -> dict[str, Any]:
    """Adapt one bagflow report into the ``fast_validation`` summary.

    The verdict rule matches ``full_validation``'s (bagflow itself has none): any
    check reporting ``ok: false`` fails the run, as does a node that died before
    end-of-stream or a flow that produced no check at all — "no failures" from a
    check that never ran would be a lie.
    """
    checks = flatten_checks(outcome.report)
    failed = [check for check in checks if check.get("ok") is False]
    incomplete = incomplete_nodes(outcome.report)
    presence = _presence(checks)
    missing = _topics(presence.get("missing")) if presence else []
    extra = _topics(presence.get("extra")) if presence else []
    passed = bool(checks) and not failed and not incomplete and presence is not None

    template = outcome.template
    bag = outcome.report.get("bag")
    return {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        # The engine that produced this verdict, so a summary on disk says which
        # implementation wrote it (v1 files carry no such key).
        "engine": "bagflow",
        "template": {
            "name": template.name if template else None,
            "version": template.version if template else None,
        },
        "result": "pass" if passed else "fail",
        # The two fields the Validation screen's checklist reads. Entries keep
        # bagflow's `reason`/`messages` detail; the UI only needs `name`/`type`.
        "missing": missing,
        "extra": extra,
        "checked_at": utc_now_iso8601(),
        "message": _message(
            presence=presence,
            missing=missing,
            failed=failed,
            incomplete=incomplete,
            wall_s=outcome.wall_s,
        ),
        "flow": outcome.flow,
        "capture_id": outcome.capture_id,
        "metrics": {
            "required": presence.get("required") if presence else None,
            "matched": presence.get("matched") if presence else None,
            "missing": len(missing),
            "extra": len(extra),
            "topics_in_bag": presence.get("topics_in_bag") if presence else None,
            "checks_total": len(checks),
            "checks_failed": len(failed),
            "wall_s": None if outcome.wall_s is None else round(outcome.wall_s, 3),
        },
        "checks": checks,
        "incomplete": incomplete,
        "bag": (
            {key: value for key, value in bag.items() if key != "topics"}
            if isinstance(bag, dict)
            else {}
        ),
    }


async def run_fast_validation(
    *,
    capture_id: str,
    data_dir: Path,
    endpoint: DoraEndpoint,
    job_name: str,
    template: ValidationTemplate,
    flow: str = DEFAULT_FLOW,
    timeout_s: float | None = None,
) -> dict[str, Any]:
    """Run the required-topic gate over one capture; return the job result."""
    return await run_bagflow_pipeline(
        pipeline_id=PIPELINE_ID,
        capture_id=capture_id,
        data_dir=data_dir,
        flow=flow,
        endpoint=endpoint,
        job_name=job_name,
        summarize=summarize,
        template=template,
        flow_dirs=flow_search_dirs(),
        timeout_s=timeout_s,
    )
