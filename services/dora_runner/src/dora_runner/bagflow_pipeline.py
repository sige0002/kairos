"""Running one bagflow flow for one job — the machinery both gates share.

``fast_validation`` and ``full_validation`` are the same act with different
declarations: materialize a flow, run it on the service's own dora stack, adapt
the ``report.json`` it wrote into kairos' ``summary.json``. Everything that is
identical between them lives here; a pipeline module supplies only

* which flow to run and where to look for it (bundled vs. the robot's config),
* how to turn the bagflow report into its summary (the ``summarize`` callback).

Layout for one job (everything under ``data/report/<pipeline>/<capture_id>/``)::

    summary.json          the kairos verdict (this is what "validated" means)
    report.json           bagflow's own report — kept as an artifact
    flow/flow.yml         the materialized flow actually run
    flow/.bagflow/…       generated dora dataflow + per-node logs

Both outputs are removed before the flow starts: a stale ``summary.json`` from an
earlier attempt would otherwise mark the run as validated after a crash.

Failure split (kairos convention): a flow that RUNS and judges the recording bad
is a *succeeded job with* ``result: fail``; a flow that could not produce a verdict
(missing input, bad flow file, crashed/timed-out dataflow) fails the JOB, with the
node logs' location in the error details — nothing is written, so the run stays
un-validated rather than silently passing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kairos_common import (
    ApiError,
    RecordingConfig,
    ValidationTemplate,
    get_settings,
    load_recording_config,
    resolve_config_path,
)
from kairos_common.atomic_io import atomic_write_text
from kairos_common.monitoring.expected_hz import make_expected_hz_resolver

from dora_runner.bagflow_flow import FlowBindings, materialize_flow
from dora_runner.bagflow_runtime import DoraEndpoint, bagflow_available, run_flow
from dora_runner.mcap_utils import enumerate_topics, find_mcap, resolve_source_dir

logger = logging.getLogger("kairos")


def recording_config() -> RecordingConfig | None:
    """The active ``RECORDING_CONFIG``, or ``None`` when absent/unreadable.

    dora_runner only reads it for flow bindings (expected Hz, required topics), so
    a missing file degrades those bindings instead of failing the job.
    """
    path = resolve_config_path(get_settings().recording_config)
    if not Path(path).is_file():
        return None
    try:
        return load_recording_config(path)
    except (ValueError, OSError) as exc:
        logger.warning(
            "recording config unreadable; flow bindings degrade",
            extra={"path": path, "error": str(exc)},
        )
        return None


def required_topics(
    template: ValidationTemplate | None, config: RecordingConfig | None
) -> list[dict[str, str | None]]:
    """Topics a flow may treat as mandatory (``${KAIROS_REQUIRED_TOPIC_SPECS}``).

    Precedence mirrors what the operator sees in the UI: the job's template (the
    active one from Settings -> Validation, injected by the orchestrator, or a
    preset's named one) first, then ``RECORDING_CONFIG``'s
    ``validation.required_topics``. Both absent means an empty list — a flow
    decides what that means for it.
    """
    if template is not None and template.required_topics:
        source = template.required_topics
    elif config is not None:
        source = config.validation.required_topics
    else:
        return []
    return [{"name": topic.name, "type": topic.type} for topic in source]


def topic_expectations(
    topics: list[str], required: list[str], config: RecordingConfig | None
) -> dict[str, float]:
    """``{topic: hz}`` for ``${KAIROS_EXPECT_HZ}`` — what the bag must contain.

    Two kairos config sources merge into the one map ``bagflow-topic-rate``
    consumes, so a flow states *that* it checks rates, never *which* rates:

    * every required topic starts at ``0``. The check node reports a topic that
      is absent from the bag as a failure and never flags a rate below ``0``, so
      ``0`` reads exactly as "must exist, any rate" — this is how the active
      validation template (Settings -> Validation) reaches the flow;
    * a topic with a static ``expected_hz_patterns`` match (recorder/monitor
      resolver, first match wins) overrides that with its real rate — including
      required topics, which then get presence AND rate checked.

    Rate expectations only cover topics the run actually contains: a topic that
    is neither required nor recorded has nothing to say about this run.
    """
    resolver = make_expected_hz_resolver(config)
    expectations: dict[str, float] = {name: 0.0 for name in required}
    for topic in topics:
        hz = resolver(topic)
        if hz is not None:
            expectations[topic] = hz
    return dict(sorted(expectations.items()))


def _clean_outputs(report_dir: Path, workdir: Path) -> None:
    """Drop the previous attempt's verdict, report and generated flow."""
    shutil.rmtree(workdir, ignore_errors=True)
    for name in ("summary.json", "report.json"):
        (report_dir / name).unlink(missing_ok=True)


# Everything a job writes is keyed by (pipeline, capture_id), so two jobs on the
# SAME capture and pipeline would wipe each other's workdir mid-flight (a
# double-clicked "validate"). Jobs run in this one process, so a per-key lock is
# enough to serialize them; other captures — and the other gate on the same
# capture — still execute concurrently up to KAIROS_DORA_MAX_CONCURRENCY.
_capture_locks: dict[tuple[str, str], asyncio.Lock] = {}


def _capture_lock(pipeline_id: str, capture_id: str) -> asyncio.Lock:
    return _capture_locks.setdefault((pipeline_id, capture_id), asyncio.Lock())


def node_logs(workdir: Path) -> list[Path]:
    """Per-node stdout/stderr files dora wrote for the run (may be empty)."""
    return sorted(workdir.glob(".bagflow/out/*/log_*.txt"))


def reported_artifact(path: Path, resolved_root: Path, configured_root: Path) -> str:
    """Re-express an artifact path in the CONFIGURED data-dir shape.

    Internally every path is absolute (the flow runs in a subprocess with its own
    cwd), but a job result must keep the same shape as every other pipeline —
    ``data/report/…`` when ``DATA_DIR`` is ``./data`` — because the orchestrator
    rewrites artifacts *relative to the configured root* before the UI turns them
    into ``GET /api/v1/files/{path}`` links. Reporting the absolute path silently
    downgrades every artifact to unclickable text.
    """
    try:
        return str(configured_root / path.relative_to(resolved_root))
    except ValueError:  # outside the data root (should not happen)
        return str(path)


def _flow_failure(
    message: str, *, capture_id: str, flow: str, workdir: Path, log_tail: list[str]
) -> ApiError:
    return ApiError(
        status_code=500,
        code="flow_failed",
        message=message,
        details={
            "capture_id": capture_id,
            "flow": flow,
            "node_logs": [str(path) for path in node_logs(workdir)],
            "log_tail": log_tail,
        },
    )


@dataclass(frozen=True)
class FlowOutcome:
    """What a finished flow gives the pipeline's summarizer."""

    report: dict[str, Any]
    flow: str
    capture_id: str
    wall_s: float
    bag_dir: Path
    template: ValidationTemplate | None


# A summarizer turns one bagflow report into the pipeline's summary.json dict.
Summarizer = Callable[[FlowOutcome], dict[str, Any]]


async def run_bagflow_pipeline(
    *,
    pipeline_id: str,
    capture_id: str,
    data_dir: Path,
    flow: str,
    endpoint: DoraEndpoint,
    job_name: str,
    summarize: Summarizer,
    template: ValidationTemplate | None = None,
    flow_dirs: list[Path] | None = None,
    timeout_s: float | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Run *flow* over one capture's bag and return the job result dict."""
    if not bagflow_available():
        raise ApiError(
            status_code=503,
            code="bagflow_unavailable",
            message=(
                f"{pipeline_id} needs the bundled bagflow/dora binaries "
                "(present in the dora_runner image only)."
            ),
        )
    async with _capture_lock(pipeline_id, capture_id):
        return await _run_locked(
            pipeline_id=pipeline_id,
            capture_id=capture_id,
            data_dir=data_dir,
            flow=flow,
            endpoint=endpoint,
            job_name=job_name,
            summarize=summarize,
            template=template,
            flow_dirs=flow_dirs,
            timeout_s=timeout_s,
            cancel_event=cancel_event,
        )


async def _run_locked(
    *,
    pipeline_id: str,
    capture_id: str,
    data_dir: Path,
    flow: str,
    endpoint: DoraEndpoint,
    job_name: str,
    summarize: Summarizer,
    template: ValidationTemplate | None,
    flow_dirs: list[Path] | None,
    timeout_s: float | None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """The body of one validation, with this capture's outputs held exclusively."""
    # Every path below is handed to a subprocess whose cwd is the flow's workdir,
    # so they must be absolute: `data_dir` is "./data" by default (settings.py),
    # which the bagflow CLI would otherwise resolve against the wrong directory.
    # Artifacts are reported back in the CONFIGURED shape (see reported_artifact).
    configured_dir = data_dir
    data_dir = data_dir.resolve()
    bag_dir = resolve_source_dir(data_dir, capture_id)
    # Fail before starting a dataflow when the capture holds no MCAP at all.
    find_mcap(bag_dir)

    report_dir = data_dir / "report" / pipeline_id / capture_id
    workdir = report_dir / "flow"
    report_dir.mkdir(parents=True, exist_ok=True)
    _clean_outputs(report_dir, workdir)

    config = recording_config()
    topics = [topic["name"] for topic in enumerate_topics(find_mcap(bag_dir))]
    required = required_topics(template, config)
    report_path = report_dir / "report.json"
    bindings = FlowBindings(
        capture_id=capture_id,
        bag_dir=bag_dir,
        report_path=report_path,
        report_dir=report_dir,
        required_topics=required,
        expect_hz=topic_expectations(
            topics, [str(topic["name"]) for topic in required], config
        ),
    )
    try:
        flow_file = materialize_flow(flow, bindings, workdir, directories=flow_dirs)
    except FileNotFoundError as exc:
        raise ApiError(
            status_code=404,
            code="flow_not_found",
            message=str(exc),
            details={"flow": flow},
        ) from exc
    except (ValueError, OSError) as exc:
        raise ApiError(
            status_code=400,
            code="invalid_flow",
            message=f"validation flow is not usable: {exc}",
            details={"flow": flow},
        ) from exc

    run = await run_flow(
        flow_file,
        name=job_name,
        endpoint=endpoint,
        timeout_s=timeout_s,
        cancel_event=cancel_event,
    )
    if not report_path.is_file():
        reason = (
            f"the flow timed out after {run.wall_s:.0f}s"
            if run.timed_out
            else f"bagflow exited {run.exit_code}"
        )
        # Put the CLI's own diagnosis in the message: the common failures (an
        # unknown topic, a node that never started) are named there exactly.
        cause = f" {run.error_line}" if run.error_line else ""
        raise _flow_failure(
            f"validation flow produced no report — {reason}.{cause}"[:500],
            capture_id=capture_id,
            flow=flow,
            workdir=workdir,
            log_tail=run.log_tail,
        )
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise _flow_failure(
            f"validation flow wrote an unreadable report: {exc}",
            capture_id=capture_id,
            flow=flow,
            workdir=workdir,
            log_tail=run.log_tail,
        ) from exc

    summary = summarize(
        FlowOutcome(
            report=report,
            flow=flow,
            capture_id=capture_id,
            wall_s=run.wall_s,
            bag_dir=bag_dir,
            template=template,
        )
    )
    summary_path = report_dir / "summary.json"
    atomic_write_text(summary_path, json.dumps(summary, indent=2))

    # The materialized flow is published on every run, pass or fail: "what did
    # this validation actually check?" is asked most often about a run that
    # PASSED, and the flow file (with ${KAIROS_*} already expanded) is the only
    # honest answer — the flow in config/ is a template, not what ran.
    produced = [summary_path, report_path, flow_file]
    if summary["result"] != "pass":
        # Node logs stay conditional: on a clean pass they are 8 files of noise
        # in the UI's artifact list, and the report already carries every check.
        produced.extend(node_logs(workdir))
    artifacts = [reported_artifact(p, data_dir, configured_dir) for p in produced]
    return {"summary": summary, "artifacts": artifacts}
